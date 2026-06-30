import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const SESSION = path.join(process.cwd(), ".fb_session.json");
  if (fs.existsSync(SESSION)) {
    await context.addCookies(JSON.parse(fs.readFileSync(SESSION, "utf8")));
  }

  const page = await context.newPage();
  const url = "https://www.facebook.com/eshikhon/posts/1011731488113410";
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(5000);

  // Let's find any element containing the text "updated their profile picture." or "updated their cover photo" or "eShikhon.com"
  console.log("Searching for the post content container...");
  
  // Find all elements with role="dialog"
  const dialog = page.locator('div[role="dialog"]').nth(2); // Dialog [2] is the post container dialog
  if (await dialog.isVisible()) {
    console.log("Dialog [2] is visible");
    
    // Let's find the main scrollable area inside the dialog, which contains the post and comments.
    // Usually it has custom styles or overflow properties.
    // Let's print all direct children of Dialog [2] and search for the main post content.
    const children = await dialog.locator('xpath=./*').all();
    console.log(`Dialog [2] has ${children.length} direct children`);
    
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const tag = await child.evaluate(el => el.tagName.toLowerCase());
      const cls = await child.evaluate(el => el.className);
      const txt = await child.textContent();
      console.log(`Child [${i}]: ${tag}.${cls.split(' ').join('.')} - Snippet: ${txt ? txt.slice(0, 100).replace(/\s+/g, ' ') : "(empty)"}`);
    }

    // Let's find the first element inside the dialog that contains the profile picture or post content.
    // We can search for the header of the post which contains the link to the page: e.g. "eShikhon.com"
    const headerLinks = await dialog.locator('a[href*="/eshikhon"]').all();
    console.log(`Found ${headerLinks.length} links containing /eshikhon inside the dialog`);
    for (let i = 0; i < headerLinks.length; i++) {
      const txt = await headerLinks[i].textContent();
      console.log(`Link [${i}]: Text="${txt}"`);
      // Print parent chain
      let parent = headerLinks[i];
      for (let j = 0; j < 4; j++) {
        parent = parent.locator('xpath=..');
        const pTag = await parent.evaluate(el => el.tagName.toLowerCase());
        const pCls = await parent.evaluate(el => el.className);
        console.log(`  Parent ${j}: ${pTag}.${pCls.split(' ').join('.')}`);
      }
    }
  } else {
    console.log("Dialog [2] not found or not visible");
  }

  await browser.close();
}

run().catch(console.error);
