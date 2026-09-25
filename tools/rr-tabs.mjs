import { chromium } from "playwright";
const b = await chromium.connectOverCDP("http://localhost:9224");
const ctx = b.contexts()[0];
for (const [i,p] of ctx.pages().entries()) console.log(i, p.url(), JSON.stringify(await p.title().catch(()=>"?")));
process.exit(0);
