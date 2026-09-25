import { chromium } from "playwright";
const b = await chromium.connectOverCDP("http://localhost:9224");
const ctx = b.contexts()[0];
for (const [i,p] of ctx.pages().entries()) {
  let id = "?";
  try { const s = await ctx.newCDPSession(p); const { targetInfo } = await s.send("Target.getTargetInfo"); id = targetInfo.targetId; await s.detach(); } catch (e) { id = "ERR " + e.message.slice(0,80); }
  console.log(i, id, p.url().slice(0,90));
}
process.exit(0);
