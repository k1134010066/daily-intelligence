import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const valueAfter = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const timeoutSeconds = Math.max(1, Number(valueAfter('--timeout-seconds') || 60));
const pollMs = Math.max(250, Number(valueAfter('--poll-ms') || 500));
const dryRun = args.includes('--dry-run');
const once = args.includes('--once');

const clickAction = dryRun
  ? 'return "MATCH:" & buttonName'
  : 'click buttonRef\n                        return "ACCEPTED:" & buttonName';

const appleScript = `
on run
    set remoteTokens to {"remote debugging", "远程调试", "Allow remote debugging for this browser instance"}
    set allowTokens to {"Allow", "允许", "Accept", "接受"}
    tell application "System Events"
        if not (exists process "Google Chrome") then return "NO_CHROME"
        tell process "Google Chrome"
            repeat with windowRef in windows
                set resultText to my inspectNode(windowRef, remoteTokens, allowTokens, 0)
                if resultText is not "NO_MATCH" then return resultText
            end repeat
        end tell
    end tell
    return "NO_MATCH"
end run

using terms from application "System Events"
on inspectNode(containerRef, remoteTokens, allowTokens, depth)
    if depth > 4 then return "NO_MATCH"
    set nodeText to ""
    set roleText to ""
    try
        set nodeText to (name of containerRef as text)
    end try
    try
        set roleText to (role of containerRef as text)
    end try
    try
        repeat with staticTextRef in (static texts of containerRef)
            try
                set nodeText to nodeText & " " & (value of staticTextRef as text)
            end try
            try
                set nodeText to nodeText & " " & (name of staticTextRef as text)
            end try
        end repeat
    end try

    set isRemotePrompt to false
    repeat with tokenRef in remoteTokens
        if nodeText contains (contents of tokenRef) then set isRemotePrompt to true
    end repeat
    set isNativeDialog to (depth is 0) or (roleText contains "dialog") or (roleText contains "sheet")

    if isRemotePrompt and isNativeDialog then
        try
            repeat with buttonRef in (buttons of containerRef)
                set buttonName to ""
                try
                    set buttonName to (name of buttonRef as text)
                end try
                repeat with allowedRef in allowTokens
                    if buttonName is (contents of allowedRef) then
                        ${clickAction}
                    end if
                end repeat
            end repeat
        end try
        return "TARGET_NO_BUTTON"
    end if

    try
        repeat with childRef in (UI elements of containerRef)
            set childResult to my inspectNode(childRef, remoteTokens, allowTokens, depth + 1)
            if childResult is not "NO_MATCH" then return childResult
        end repeat
    end try
    return "NO_MATCH"
end inspectNode
end using terms from
`;

function probe() {
  return new Promise(resolve => {
    const scriptArgs = ['-l', 'AppleScript'];
    for (const line of appleScript.split('\n')) {
      if (line.trim()) scriptArgs.push('-e', line);
    }
    const child = spawn('/usr/bin/osascript', scriptArgs, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => resolve({ stdout: '', stderr: error.message, code: -1 }));
    child.on('close', code => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code }));
  });
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function main() {
  if (process.platform !== 'darwin') {
    console.log('[cdp-permission] skipped: macOS only');
    return;
  }
  const deadline = Date.now() + timeoutSeconds * 1000;
  let reportedAccessibilityError = false;
  do {
    const result = await probe();
    if ((dryRun || once) && (result.stderr || result.stdout)) {
      console.log(`[cdp-permission] probe: ${result.stdout || result.stderr}`);
    }
    if (result.stderr && !reportedAccessibilityError && /not authorized|assistive|accessibility|权限|-10827|event.*permit/i.test(result.stderr)) {
      reportedAccessibilityError = true;
      console.log(`[cdp-permission] accessibility unavailable: ${result.stderr}`);
    }
    if (result.stdout && !['NO_MATCH', 'NO_CHROME'].includes(result.stdout)) {
      console.log(`[cdp-permission] ${result.stdout}`);
      if (result.stdout.startsWith('ACCEPTED:') || result.stdout.startsWith('MATCH:')) return;
    }
    if (once) {
      if (!result.stdout && !result.stderr) console.log('[cdp-permission] probe: NO_MATCH');
      return;
    }
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  } while (Date.now() < deadline);
  console.log(`[cdp-permission] no matching prompt before timeout (${timeoutSeconds}s)`);
}

main().catch(error => {
  console.log(`[cdp-permission] watcher failed closed: ${error.message}`);
});
