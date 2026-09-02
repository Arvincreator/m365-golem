export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

export function parseApprovalResult(stdout: string): ApprovalDecision {
  const lines = stdout.split(/\r?\n/);
  const resultLine = lines.length === 1 ? lines[0] : lines.length === 2 && lines[1] === "" ? lines[0] : null;
  if (resultLine === "RESULT:ALLOW_ONCE") return "allow-once";
  if (resultLine === "RESULT:ALLOW_ALWAYS") return "allow-always";
  return "deny";
}
