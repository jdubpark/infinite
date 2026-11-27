process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdout.write("READY\r\n\x1b[?2004h\x1b[?25l\x1b[?1006h");
let pending = "";
let permissionOpen = false;
let permissionHold;
let collapsedPermissionOpen = false;
let expansionCount = 0;
let feedbackOpen = false;
let feedbackMarker = 0;
let feedbackText;
const drawFeedback = () => process.stdout.write("\x1b[2J\x1b[HBash command\r\nnpm run check\r\nDo you want to proceed?\r\n" +
  (feedbackMarker === 0 ? "❯" : " ") + " 1. Yes\r\n" + (feedbackMarker === 1 ? "❯" : " ") + " 2. No, and tell Claude what to do differently (esc)\r\n");
process.stdin.on("data", data => {
  if (feedbackText !== undefined) {
    feedbackText += data;
    const end = feedbackText.indexOf("\r");
    if (end >= 0) {
      process.stdout.write("FEEDBACK " + feedbackText.slice(0, end).replace(/\x1b\[20[01]~/g, "") + "\r\n");
      feedbackText = undefined;
    }
    return;
  }
  if (feedbackOpen) {
    if (data.includes("\x1b[B")) { feedbackMarker = 1; drawFeedback(); }
    else if (data.includes("\r")) {
      feedbackOpen = false;
      if (feedbackMarker === 1) { feedbackText = ""; process.stdout.write("\x1b[2J\x1b[HTell Claude what to do differently\r\n> "); }
      else process.stdout.write("\x1b[2J\x1b[HAPPROVED\r\n");
    }
    return;
  }
  if (collapsedPermissionOpen && data.includes("\r")) {
    process.stdout.write("COLLAPSED ENTER RECEIVED\r\n");
    return;
  }
  if (collapsedPermissionOpen && data.includes("\x01")) {
    expansionCount++;
    process.stdout.write("\x1b[2J\x1b[HWould you like to run the following command?\r\n  $ npm run check\r\n  Expanded command text, displayed only.\r\nEXPANDED ONCE " + expansionCount + "\r\n› 1. Yes, proceed (y)\r\n  2. No, and tell Codex what to do differently (esc)\r\n");
    return;
  }
  if (permissionOpen && data.includes("\x1b[B")) {
    const moved = () => process.stdout.write("\x1b[2J\x1b[Hnpm run check\r\nPermission needed\r\n  1. No\r\n❯ 2. Yes, proceed once\r\n");
    if (permissionHold) fetch(permissionHold).then(moved, () => {});
    else setTimeout(moved, 150);
    return;
  }
  if (permissionOpen && data.includes("\r")) {
    permissionOpen = false;
    process.stdout.write("\x1b[2J\x1b[HAPPROVED\r\n");
    return;
  }
  pending += data;
  let end;
  while ((end = pending.indexOf("\n")) >= 0) {
    const command = pending.slice(0, end); pending = pending.slice(end + 1);
    if (command === "burst") {
      for (let i = 1; i <= 320; i++) process.stdout.write("\x1b[32mROW " + i + " café 界\x1b[0m\r\n");
    } else if (command.split(" ")[0] === "permission") {
      permissionOpen = true;
      permissionHold = command.split(" ")[1];
      process.stdout.write("\x1b[2J\x1b[Hnpm run check\r\nPermission needed\r\n❯ 1. No\r\n  2. Yes, proceed once\r\n");
      fetch(process.env.INFINITE_HOOK_URL + "/claude", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.INFINITE_HOOK_TOKEN },
        body: JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "fixture-native-session", tool_name: "Bash", tool_input: { command: "npm run check" } }),
      });
    } else if (command === "feedback-permission") {
      feedbackOpen = true;
      feedbackMarker = 0;
      drawFeedback();
      fetch(process.env.INFINITE_HOOK_URL + "/claude", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.INFINITE_HOOK_TOKEN },
        body: JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "fixture-native-session", tool_name: "Bash", tool_input: { command: "npm run check" } }),
      });
    } else if (command === "collapsed-permission") {
      collapsedPermissionOpen = true;
      process.stdout.write("\x1b[2J\x1b[HReason: Inspect the requested files.\r\n  $ npm run check\r\n  [… 4 lines] ^a view all\r\n› 1. Yes, proceed (y)\r\n  2. No, and tell Codex what to do differently (esc)\r\n");
    } else if (command === "split") process.stdout.write("\x1b[");
    else if (command === "finish") process.stdout.write("31mSPLIT COMPLETE\x1b[0m\r\n");
    else if (command === "alt") process.stdout.write("\x1b[?1049h\x1b[H\x1b[34mALTERNATE 界\x1b[0m\r\nNative prompt> ");
    else if (command === "leavealt") process.stdout.write("\x1b[?1049lBACK FROM ALTERNATE\r\n");
    else if (command === "reset") process.stdout.write("\x1bcRESET DONE\r\n");
    else if (command === "title") process.stdout.write("\x1b]0;Initial title\x07\x1b]1;Infinite icon\x1b\\\x1b]2;Infinite workspace\x07TITLE DONE\r\n");
    else if (command.startsWith("sgr ")) {
      const params = command.slice(4);
      process.stdout.write("\x1b[" + params + "mSTYLED TEXT\x1b[0mSGR DONE " + params + "\r\n");
    }
    else if (command.startsWith("osc ")) {
      const code = command.slice(4);
      const sequence = {
        8: "\x1b]8;;https://example.test/task\x07Task link\x1b]8;;\x07",
        4: "\x1b]4;1;rgb:11/22/33\x1b\\",
        10: "\x1b]10;rgb:11/22/33\x07",
        11: "\x1b]11;rgb:11/22/33\x07",
      }[code];
      process.stdout.write(sequence + "OSC DONE " + code + "\r\n");
    }
    else if (command === "stream") {
      for (let i = 1; i <= 10; i++) process.stdout.write("LIVE " + i + "\r\n");
    } else if (command === "resume") {
      let i = 10;
      const timer = setInterval(() => {
        process.stdout.write("LIVE " + (++i) + "\r\n");
        if (i === 150) { clearInterval(timer); process.stdout.write("STREAM DONE\r\n"); }
      }, 2);
    } else if (command.startsWith("hook ")) {
      const [, kind, id] = command.split(" ");
      fetch(process.env.INFINITE_HOOK_URL + "/" + (kind === "wrong" ? "codex" : "claude"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + (kind === "bad" ? "wrong-token" : process.env.INFINITE_HOOK_TOKEN) },
        body: JSON.stringify({ hook_event_name: "Stop", session_id: id, ...(kind === "agent" ? { agent_id: "subagent-1" } : {}) }),
      }).then(() => process.stdout.write("HOOK DONE " + kind + " " + id + "\r\n"));
    } else process.stdout.write("RECEIVED " + command + "\r\n");
  }
});
