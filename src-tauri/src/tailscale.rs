use std::collections::HashMap;
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::error::Error;

const APP_BINARY: &str = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawStatus {
    current_tailnet: Option<RawTailnet>,
    #[serde(rename = "Self")]
    self_node: RawPeer,
    #[serde(default)]
    peer: HashMap<String, RawPeer>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawTailnet {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawPeer {
    host_name: String,
    #[serde(rename = "DNSName", default)]
    dns_name: String,
    #[serde(rename = "OS", default)]
    os: String,
    #[serde(default)]
    online: bool,
    #[serde(default)]
    exit_node_option: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    /// DNS label, which is what Taildrive uses in its URLs.
    pub name: String,
    pub host_name: String,
    pub os: String,
    pub online: bool,
    pub is_self: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub tailnet: String,
    pub machines: Vec<Machine>,
}

fn run_status() -> Result<Vec<u8>, Error> {
    let attempt = |bin: &str| Command::new(bin).args(["status", "--json"]).output();
    let out = attempt("tailscale").or_else(|_| attempt(APP_BINARY))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(Error::Msg(format!(
            "tailscale status failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )))
    }
}

fn to_machine(p: &RawPeer, is_self: bool) -> Option<Machine> {
    let name = p
        .dns_name
        .split('.')
        .next()
        .filter(|n| !n.is_empty())?
        .to_owned();
    Some(Machine {
        name,
        host_name: p.host_name.clone(),
        os: p.os.clone(),
        online: p.online || is_self,
        is_self,
    })
}

pub fn status() -> Result<Status, Error> {
    let raw: RawStatus = serde_json::from_slice(&run_status()?)
        .map_err(|e| Error::Msg(format!("unreadable tailscale status: {e}")))?;
    let tailnet = raw
        .current_tailnet
        .map(|t| t.name)
        .ok_or_else(|| Error::Msg("tailscale is not connected to a tailnet".to_owned()))?;

    let mut machines: Vec<Machine> = std::iter::once(to_machine(&raw.self_node, true))
        .chain(
            raw.peer
                .values()
                .filter(|p| !p.exit_node_option && p.host_name != "localhost")
                .map(|p| to_machine(p, false)),
        )
        .flatten()
        .collect();
    machines.sort_by(|a, b| {
        b.is_self
            .cmp(&a.is_self)
            .then(b.online.cmp(&a.online))
            .then(a.host_name.to_lowercase().cmp(&b.host_name.to_lowercase()))
    });
    machines.dedup_by(|a, b| a.name == b.name);
    Ok(Status { tailnet, machines })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Skips silently when Tailscale is not installed or not connected.
    #[test]
    fn parses_live_status() {
        let Ok(s) = status() else { return };
        assert_ne!(s.tailnet, "");
        assert!(s.machines.first().is_some_and(|m| m.is_self));
        assert!(
            s.machines
                .iter()
                .all(|m| !m.name.is_empty() && m.host_name != "localhost")
        );
        eprintln!(
            "{} machines: {:?}",
            s.machines.len(),
            s.machines
                .iter()
                .map(|m| (&m.name, m.online))
                .collect::<Vec<_>>()
        );
    }
}
