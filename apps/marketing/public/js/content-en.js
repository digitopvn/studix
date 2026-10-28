/* English copy for the Motion MCP landing. Loaded before site.js; content-vi.js mirrors these keys. */
window.SITE_CONTENT = (() => {
const samples = [ // id, name, aspect, seconds, film, brief, note, bento span
  ["SC 01", "Product launch", "16:9", "9.5 s", "launch", "Launch teaser for Quiet Hours, a focus timer app. Calm, editorial, a little smug about silence.", "", "c4"],
  ["SC 02", "Social reel", "9:16", "8.2 s", "kinetic", "Nobody reads the manual, so make it move. Loud, playful.", "", "c2"],
  ["SC 03", "Local ad", "4:5", "9.5 s", "bakery", "Quảng cáo lớp làm bánh mì chua cuối tuần. Ấm áp, gần gũi, tiếng Việt.", "Briefed and rendered in Vietnamese. Diacritics included, at no extra charge.", "c2"],
  ["SC 04", "Data story", "16:9", "9.0 s", "data", "A data story about developer coffee habits. Deadpan humor, dark editorial charts feel.", "", "c4"],
  ["SC 05", "Invitation", "1:1", "9.0 s", "event", "Square invite for a year-end company party. Elegant, with a wink.", "", "c3"],
  ["SC 06", "Explainer", "16:9", "9.5 s", "explainer", "Technical explainer: how one MCP call turns a brief into a finished video. Blueprint feel.", "", "c3"],
];
const steps = [ // number, role, title, body, aside
  ["01", "You", "Write the brief", "Say what you need, in plain words. “A calm launch teaser, no gradients” is plenty.", "Vietnamese works too."],
  ["02", "The director", "Set the taste", "A top model (Claude Opus) decides the story, pacing, type and color. It is expensive, so it is only called when taste matters.", "It does not write code. It has people for that."],
  ["03", "The crew", "Build every scene", "Code and small, fast models turn the plan into scenes. A producer (Jev) decides who fixes what, and whether a fix is worth paying for.", "Cheap where it can be, smart where it must be."],
  ["04", "The editor", "Check, then render", "Every scene is checked frame by frame before the final render.", "You get a web-ready MP4 and a link to share it."],
];
const briefs = ["Make a 10-second vertical teaser for my Saturday bread class. Warm, friendly, in Vietnamese.", "A calm launch teaser, no gradients.", "Square invite for a year-end party. Elegant, with a wink."];
const compare = [
  ["Text on screen", "Melted letters, creative spelling", "Real typography, spelled right every time"],
  ["Changing one thing", "Regenerate everything and hope", "Say what to change. Only that scene is rebuilt."],
  ["Your brand", "Colors that are “close enough”", "Your exact colors, clean type, same result every render"],
  ["Cost", "A big model on every step", "A big model only for taste. Code does the chores."],
  ["What happened", "A black box", "Every step and its cost, visible in your dashboard"],
];
const chat = [ // role, html, pause before (ms)
  ["you", "Make a 10-second vertical teaser for my Saturday bread class. Warm, friendly, in Vietnamese.", 300],
  ["ai", "On it. I sent the brief to Motion MCP, reviewed the preview frames and asked for the final render.<br/><code>motion_create → motion_render</code><br/>Here is your MP4, 1080 × 1920. Want the date in bigger type?", 800],
  ["you", "Yes. And make it a bit more cozy.", 1300],
  ["sys", "Only the scene with the date is rebuilt. The rest stays exactly as you approved it.", 900],
];
const tools = [
  ["motion_create", "Start a video from a brief, or from a creative spec your own model wrote."],
  ["motion_edit", "Revise in plain words or with typed scene patches."],
  ["motion_inspect", "Schema, director modes, pricing and limits in one call."],
  ["motion_render", "Draft preview, or the final once every check passes."],
  ["motion_search", "Styles, shot patterns, recipes and past projects."],
  ["motion_get_project", "Progress, versions, renders, usage and a cost trace."],
  ["motion_list_projects", "Page through your workspace."],
  ["motion_publish", "A stable share link, unlisted or public."],
];
const prices = [
  ["Your assistant directs", "32", "credits", "What each 10-second sample above cost when the calling assistant wrote the creative plan."],
  ["Our director directs", "~130", "credits", "Add one call to our creative director, 100 credits, when you send only a brief."],
  ["Early access", "5,000", "free credits", "Every new account starts with 5,000 credits. Paid top-ups come later. For now, make things.", true],
];
const faq = [
  ["Do I need to know how to code or edit video?", "No. You describe the video in plain words, to your AI assistant or in the dashboard. The code and the editing happen behind the scenes."],
  ["What kinds of videos can it make?", "Motion graphics: launch teasers, explainers, social reels, data stories, invitations and announcements, in 16:9, 9:16, 1:1 or 4:5. It composes text, shapes, numbers and code on screen. It does not film people or generate photoreal footage."],
  ["What if I don't like the result?", "Say what to change: “bigger date”, “slower second scene”, “warmer colors”. Only the affected scenes are rebuilt, so the parts you liked stay put."],
  ["Can I download and post the videos?", "Yes. Every final render is a web-ready MP4 you can download, or share through a stable link from the dashboard."],
  ["Can I run it on my own servers?", "Yes. The whole stack is open source under the MIT licence. Bring your own model keys, and billing can be switched off entirely."],
];
const ui = {
  introTitle: "Motion MCP intro", watchFilm: "Watch film ↗", you: "You", assistant: "Your assistant",
  copy: "Copy", copied: "Copied", startFree: "Start free", video: "Video", showVideo: "Show video",
  soundOn: "Turn sound on", soundOff: "Turn sound off", locale: "en-US",
  filters: { All: "All", Motion: "Motion", Product: "Product", Reels: "Reels", Story: "Story" },
};
return { samples, steps, briefs, compare, chat, tools, prices, faq, ui };
})();
