//! Minimal Cloudflare R2 client (S3 API, `SigV4`, unsigned payload over HTTPS).

use std::fmt::Write as _;
use std::path::Path;

use hmac::{Hmac, KeyInit, Mac};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::{Body, Client, Method, StatusCode, header};
use sha2::{Digest, Sha256};

use crate::error::Error;

pub const TARGET_PREFIX: &str = "r2:";
const KEYCHAIN_SERVICE: &str = "manplay-r2";
const UNSIGNED: &str = "UNSIGNED-PAYLOAD";
const ENCODE: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

#[derive(Clone)]
pub struct R2 {
    pub account: String,
    pub bucket: String,
    key_id: String,
    secret: String,
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    // HMAC accepts keys of any length, so this cannot fail.
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(key) else {
        return Vec::new();
    };
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// `(YYYYMMDD, YYYYMMDD'T'HHMMSS'Z')` in UTC.
fn timestamps(unix: i64) -> (String, String) {
    let days = unix.div_euclid(86_400);
    let secs = unix.rem_euclid(86_400);
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    let date = format!("{y:04}{m:02}{d:02}");
    let full = format!(
        "{date}T{:02}{:02}{:02}Z",
        secs / 3600,
        secs % 3600 / 60,
        secs % 60
    );
    (date, full)
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(0))
}

impl R2 {
    pub fn new(account: &str, bucket: &str, key_id: &str, secret: &str) -> Self {
        Self {
            account: account.to_owned(),
            bucket: bucket.to_owned(),
            key_id: key_id.to_owned(),
            secret: secret.to_owned(),
        }
    }

    fn host(&self) -> String {
        format!("{}.r2.cloudflarestorage.com", self.account)
    }

    /// `key` empty addresses the bucket itself.
    fn path(&self, key: &[String]) -> String {
        let mut out = format!("/{}", utf8_percent_encode(&self.bucket, ENCODE));
        for s in key {
            out.push('/');
            out.push_str(&utf8_percent_encode(s, ENCODE).to_string());
        }
        out
    }

    fn request(&self, client: &Client, method: &Method, key: &[String]) -> reqwest::RequestBuilder {
        let host = self.host();
        let path = self.path(key);
        let (date, stamp) = timestamps(now());
        let canonical = format!(
            "{method}\n{path}\n\nhost:{host}\nx-amz-content-sha256:{UNSIGNED}\nx-amz-date:{stamp}\n\nhost;x-amz-content-sha256;x-amz-date\n{UNSIGNED}"
        );
        let scope = format!("{date}/auto/s3/aws4_request");
        let to_sign = format!(
            "AWS4-HMAC-SHA256\n{stamp}\n{scope}\n{}",
            hex(&Sha256::digest(canonical.as_bytes()))
        );
        let k = hmac(format!("AWS4{}", self.secret).as_bytes(), &date);
        let k = hmac(&k, "auto");
        let k = hmac(&k, "s3");
        let k = hmac(&k, "aws4_request");
        let sig = hex(&hmac(&k, &to_sign));
        let auth = format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature={sig}",
            self.key_id
        );
        client
            .request(method.clone(), format!("https://{host}{path}"))
            .header("x-amz-date", stamp)
            .header("x-amz-content-sha256", UNSIGNED)
            .header(header::AUTHORIZATION, auth)
    }

    /// Verifies credentials and that the bucket exists.
    pub async fn check(&self, client: &Client) -> Result<(), Error> {
        let resp = self.request(client, &Method::HEAD, &[]).send().await?;
        match resp.status() {
            s if s.is_success() => Ok(()),
            StatusCode::NOT_FOUND => Err(Error::Msg("bucket not found".to_owned())),
            StatusCode::FORBIDDEN | StatusCode::UNAUTHORIZED => Err(Error::Msg(
                "access denied: check the account ID, keys and bucket permissions".to_owned(),
            )),
            s => Err(Error::Msg(format!("r2 HEAD bucket {s}"))),
        }
    }

    pub async fn remote_size(&self, client: &Client, key: &[String]) -> Result<Option<u64>, Error> {
        let resp = self.request(client, &Method::HEAD, key).send().await?;
        match resp.status() {
            StatusCode::NOT_FOUND => Ok(None),
            s if s.is_success() => Ok(resp
                .headers()
                .get(header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse().ok())),
            s => Err(Error::Msg(format!("r2 HEAD {s}"))),
        }
    }

    pub async fn put(&self, client: &Client, key: &[String], file: &Path) -> Result<(), Error> {
        let handle = tokio::fs::File::open(file).await?;
        let len = handle.metadata().await?.len();
        let resp = self
            .request(client, &Method::PUT, key)
            .header(header::CONTENT_LENGTH, len)
            .body(Body::from(handle))
            .send()
            .await?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(Error::Msg(format!("r2 PUT {}", resp.status())))
        }
    }

    /// A file that is already gone counts as success.
    pub async fn delete(&self, client: &Client, key: &[String]) -> Result<(), Error> {
        let resp = self.request(client, &Method::DELETE, key).send().await?;
        match resp.status() {
            StatusCode::NOT_FOUND => Ok(()),
            s if s.is_success() => Ok(()),
            s => Err(Error::Msg(format!("r2 DELETE {s}"))),
        }
    }

    pub fn save_credentials(&self, target_id: i64) -> Result<(), Error> {
        entry(target_id)?
            .set_password(&format!("{}\n{}", self.key_id, self.secret))
            .map_err(|e| Error::Msg(format!("keychain: {e}")))
    }

    pub fn load(account: &str, bucket: &str, target_id: i64) -> Result<Self, Error> {
        let stored = entry(target_id)?
            .get_password()
            .map_err(|e| Error::Msg(format!("keychain: {e}")))?;
        let (key_id, secret) = stored
            .split_once('\n')
            .ok_or_else(|| Error::Msg("keychain: malformed R2 credentials".to_owned()))?;
        Ok(Self::new(account, bucket, key_id, secret))
    }
}

pub fn forget_credentials(target_id: i64) {
    if let Ok(e) = entry(target_id) {
        let _ = e.delete_credential();
    }
}

fn entry(target_id: i64) -> Result<keyring::Entry, Error> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &format!("target-{target_id}"))
        .map_err(|e| Error::Msg(format!("keychain: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_format() {
        assert_eq!(
            timestamps(1_440_938_160),
            ("20150830".to_owned(), "20150830T123600Z".to_owned())
        );
        assert_eq!(timestamps(0).0, "19700101");
    }

    #[test]
    fn encodes_keys() {
        let r2 = R2::new("a", "b", "k", "s");
        assert_eq!(
            r2.path(&["Ärtist".to_owned(), "a b#1.wav".to_owned()]),
            "/b/%C3%84rtist/a%20b%231.wav"
        );
    }
}
