import { Button } from "#/components/ui/button.tsx";
import { openPrivacySettings } from "#/lib/api.ts";

/** Start of the backend's message when macOS privacy settings block a folder. */
const BLOCKED = "macOS blocked access";

/** An error message; macOS permission errors get a button to the right settings page. */
export function ErrorText({ message, className }: { message: string; className?: string }) {
	return (
		<div className={className}>
			<p>{message}</p>
			{message.includes(BLOCKED) && (
				<Button variant="outline" size="sm" className="mt-2" onClick={() => openPrivacySettings()}>
					Open Privacy Settings
				</Button>
			)}
		</div>
	);
}
