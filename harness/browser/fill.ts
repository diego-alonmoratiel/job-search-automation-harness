// fill.ts - DOM form filler for the job-search harness.
//
// Fills a job-application form from a answers.json bank, uploads the CV/cover
// PDFs, takes a screenshot and (only with --submit) clicks submit. By default it
// stops before submitting so the harness can ask the owner for an "ok".
//
// Usage:
//   DISPLAY=:99 bun run fill.ts --url <postingUrl> --answers <answers.json> \
//     --cv <cv.pdf> [--cover <cover.pdf>] --screenshot <out.png> [--submit]
//
// It prints a single JSON object to stdout describing what it did.

import { chromium, type BrowserContext, type Page } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

const url = arg("url");
if (!url) {
  console.error("missing --url");
  process.exit(2);
}
const answersPath = arg("answers", `${process.env.HOME}/job-harness/config/answers.json`)!;
const cvPath = arg("cv");
const coverPath = arg("cover");
const screenshotPath = arg("screenshot", "/tmp/harness-fill.png")!;
const profileDir = arg("profile-dir", `${process.env.HOME}/job-harness/state/chromium-profile`)!;
const submit = hasFlag("submit");
const cdpPort = arg("cdp-port");
const noNavigate = hasFlag("no-navigate");
const screenshotOnly = hasFlag("screenshot-only");
const verifyCode = arg("verify-code");
const exe = process.env.CHROME_EXECUTABLE ?? "/usr/bin/chromium";

const answers = JSON.parse(readFileSync(answersPath, "utf-8")) as Record<string, string>;

// Ordered: first matching key wins, so specific keys precede generic ones.
const FIELD_KEYS: Array<[string, RegExp]> = [
  ["first_name", /(first\s*name|given\s*name|vorname|pr[eé]nom)/i],
  ["last_name", /(last\s*name|family\s*name|surname|nachname|nom de famille)/i],
  ["email", /(e-?mail|courriel)/i],
  ["phone", /(phone|mobile|telephone|telefon|\btel\b)/i],
  ["linkedin", /linkedin/i],
  ["github", /github/i],
  ["website", /(website|portfolio|personal\s*site|homepage)/i],
  ["current_company", /(current\s*(company|employer)|employer|company\s*name|arbeitgeber)/i],
  ["current_title", /(current\s*(title|position|role)|job\s*title|position\s*title)/i],
  ["salary_expectation", /(salary|compensation|expected\s*pay|gehalt|remuneration)/i],
  ["notice_period", /(notice\s*period|k[uü]ndigungsfrist)/i],
  ["availability", /(availability|available\s*from|start\s*date|earliest\s*start|eintritt)/i],
  ["years_experience", /(years?\s*of\s*experience|experience\s*\(years\))/i],
  ["account_password", /(password|passwort|mot de passe|contrase[nñ]a)/i],
  ["date_of_birth", /(date\s*of\s*birth|birth\s*date|d\.?o\.?b\.?|geburtsdatum)/i],
  ["gender", /(gender|geschlecht)/i],
  ["requires_sponsorship", /(sponsorship|visa\s*sponsor|patrocinio)/i],
  ["work_authorization", /(work\s*authorization|right\s*to\s*work|arbeitserlaubnis)/i],
  ["us_person", /(us\s*person|itar|export\s*control)/i],
  ["willing_to_relocate", /(relocat)/i],
  ["citizenship", /(citizenship|nationality|staatsangeh)/i],
  ["place_of_birth", /(place\s*of\s*birth|birthplace|birth\s*place|geburtsort)/i],
  ["city", /(location\s*\(city\)|\bcity\b|stadt)/i],
  ["address", /(current\s*address|\baddress\b|adresse)/i],
  ["location", /(current\s*location|location|residence|wohnort|\bort\b)/i],
  ["country", /\bcountry\b/i],
  ["full_name", /(full\s*name|your\s*name|nombre completo|\bname\b)/i],
  ["how_did_you_hear", /(how\s*did\s*you.*(hear|find)|referred|\bsource\b)/i],
];

function matchKey(descriptor: string): string | undefined {
  for (const [key, re] of FIELD_KEYS) {
    if (re.test(descriptor) && answers[key] && answers[key].trim() !== "") return key;
  }
  return undefined;
}

// Stable synthetic key for a required field we have no standard mapping for, so
// the harness can ask the owner and re-fill it on the next pass.
function synthKeyFor(descriptor: string): string {
  const m = /question_(\d+)/.exec(descriptor);
  if (m) return `q_${m[1]}`;
  const h = createHash("sha1").update(descriptor).digest("hex").slice(0, 8);
  return `q_${h}`;
}

// A descriptor we can actually show the owner. Generic placeholders like
// "Select..." carry no question text, so we never synthesise an ask key for them.
function isInformative(descriptor: string): boolean {
  const d = descriptor.replace(/\s+/g, " ").trim();
  return d.length >= 6 && !/^select\.*$/i.test(d);
}

// Fields only filled when the form marks them required (voluntary self-ID).
const VOLUNTARY_ONLY = new Set(["date_of_birth", "gender"]);

// Verification-code fields: the harness asks the owner and fills them without
// reloading the page (see --verify-code).
const VERIFY_RE = /(verification\s*code|one[-\s]?time|\botp\b|c[oó]digo|security\s*code|verification\s*token|code sent)/i;

function startDateMonday(): string {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  // Move forward to the next Monday (1). If already Monday, keep it.
  const day = d.getDay();
  const delta = day === 1 ? 0 : (8 - day) % 7 || 7;
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}

function isoToDdmmyyyy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

function resolveValue(key: string, value: string, field: FieldInfo): string {
  if (value === "@start_date_monday") return startDateMonday();
  if (key === "date_of_birth") {
    if (field.type === "date") return answers.date_of_birth ?? value;
    return answers.date_of_birth_text ?? isoToDdmmyyyy(value);
  }
  return value;
}

type FieldInfo = {
  idx: number;
  tag: string;
  type: string;
  role?: string;
  descriptor: string;
  required: boolean;
  visible: boolean;
  options?: string[];
};

async function gatherFields(page: Page): Promise<FieldInfo[]> {
  return await page.evaluate(() => {
    function labelText(el: Element): string {
      const id = el.getAttribute("id");
      let text = "";
      if (id) {
        const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (l) text += " " + (l.textContent || "");
      }
      const closest = el.closest("label");
      if (closest) text += " " + (closest.textContent || "");
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        for (const lid of labelledBy.split(/\s+/)) {
          const l = document.getElementById(lid);
          if (l) text += " " + (l.textContent || "");
        }
      }
      if (!text.trim()) {
        // Climb a few ancestors to find the surrounding question text, ignoring
        // text that belongs to form controls (option labels, input values).
        let node: Element | null = el.parentElement;
        for (let depth = 0; depth < 5 && node; depth++) {
          const clone = node.cloneNode(true) as Element;
          clone.querySelectorAll("input, select, textarea, option, button").forEach((n) => n.remove());
          const t = (clone.textContent || "").replace(/\s+/g, " ").trim();
          if (t && t.length <= 300) {
            text = " " + t;
            break;
          }
          node = node.parentElement;
        }
      }
      return text;
    }
    const out: any[] = [];
    const els = Array.from(
      document.querySelectorAll("input, textarea, select")
    ) as HTMLElement[];
    let i = 0;
    for (const el of els) {
      const input = el as HTMLInputElement;
      const type = (input.type || el.tagName.toLowerCase()).toLowerCase();
      if (["hidden", "submit", "button", "image", "reset"].includes(type)) continue;
      const style = window.getComputedStyle(el);
      const visible = style.display !== "none" && style.visibility !== "hidden" && input.offsetParent !== null;
      const domLabels = (input.labels ? Array.from(input.labels) : [])
        .map((l) => (l.textContent || "").trim())
        .filter(Boolean)
        .join(" ");
      const descriptor = [
        input.name,
        input.id,
        input.placeholder,
        el.getAttribute("aria-label"),
        domLabels,
        labelText(el),
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      el.setAttribute("data-harness-idx", String(i));
      const options =
        el.tagName.toLowerCase() === "select"
          ? Array.from((el as HTMLSelectElement).options).map((o) => o.text.trim())
          : undefined;
      out.push({
        idx: i,
        tag: el.tagName.toLowerCase(),
        type,
        role: el.getAttribute("role") || undefined,
        descriptor,
        required: (input.required || el.getAttribute("aria-required") === "true") && type !== "file",
        visible,
        options,
      });
      i++;
    }
    return out;
  });
}

async function fillOne(page: Page, field: FieldInfo, value: string): Promise<boolean> {
  const sel = `[data-harness-idx="${field.idx}"]`;
  try {
    if (field.role === "combobox" && field.tag === "input") {
      // react-select / custom dropdown: open, type, then click the matching option.
      const box = page.locator(sel);
      await box.click({ timeout: 5000 });
      await page.waitForTimeout(250);
      try {
        await box.fill("");
      } catch {
        /* not always clearable */
      }
      await page.keyboard.type(value, { delay: 30 });
      await page.waitForTimeout(800);
      const options = page.getByRole("option");
      const n = await options.count();
      for (let i = 0; i < n; i++) {
        const o = options.nth(i);
        const txt = ((await o.textContent().catch(() => "")) || "").toLowerCase();
        if (txt.includes(value.toLowerCase())) {
          await o.click({ timeout: 3000 });
          await page.waitForTimeout(200);
          return true;
        }
      }
      await page.keyboard.press("Escape").catch(() => {});
      return false;
    }
    if (field.tag === "select") {
      // Prefer an option whose text contains the answer; fall back to yes/no.
      const v = value.toLowerCase();
      const opt = await page.$eval(
        sel,
        (el, val) => {
          const options = Array.from((el as HTMLSelectElement).options);
          const hit = options.find((o) => o.text.toLowerCase().includes(val) || o.value.toLowerCase() === val);
          return hit ? hit.value : null;
        },
        v
      );
      if (opt === null) return false;
      await page.selectOption(sel, opt);
      return true;
    }
    if (field.type === "radio") {
      // Click the radio in the same group whose label matches the value.
      const name = await page.$eval(sel, (el) => (el as HTMLInputElement).name);
      if (!name) return false;
      const ok = await page.$$eval(
        "input[type=radio]",
        (els, args) =>
          els.some((el) => {
            const inp = el as HTMLInputElement;
            if (inp.name !== args.name) return false;
            const label = (el.closest("label")?.textContent || "").toLowerCase();
            if (label.includes(args.val)) {
              inp.click();
              return true;
            }
            return false;
          }),
        { name, val: value.toLowerCase() }
      );
      return ok;
    }
    if (field.type === "checkbox") {
      const want = /^(yes|true|1|si|sí)$/i.test(value.trim());
      const checked = await page.$eval(sel, (el) => (el as HTMLInputElement).checked);
      if (want !== checked) await page.click(sel);
      return true;
    }
    await page.fill(sel, value, { timeout: 5000 });
    return true;
  } catch (err) {
    if (process.env.HARNESS_FILL_DEBUG) {
      console.error(`fillOne idx=${field.idx} type=${field.type} failed: ${(err as Error).message.split("\n")[0]}`);
    }
    return false;
  }
}

async function dismissOverlays(page: Page): Promise<void> {
  const texts = [
    "Accept All Cookies", "Accept all cookies", "Accept all", "Accept Cookies", "Accept",
    "Reject All", "Aceptar todas", "Aceptar todo", "Aceptar", "Alle akzeptieren", "Akzeptieren",
    "Tout accepter", "Accepter", "Got it", "I agree", "Allow all",
  ];
  for (const t of texts) {
    try {
      const btn = page.getByRole("button", { name: t, exact: false }).first();
      if (await btn.isVisible({ timeout: 400 })) {
        await btn.click({ timeout: 2000 });
        await page.waitForTimeout(400);
      }
    } catch {
      /* ignore */
    }
  }
}

async function findFormUrl(page: Page, startUrl: string): Promise<void> {
  const fieldCount = async () => (await page.$$("input:not([type=hidden]), textarea, select")).length;
  await dismissOverlays(page);
  if ((await fieldCount()) >= 3) return;
  const candidates = [
    'a:has-text("I\'m interested")',
    'button:has-text("I\'m interested")',
    'a:has-text("Apply for this job")',
    'button:has-text("Apply for this job")',
    'a:has-text("Apply now")',
    'button:has-text("Apply now")',
    'a:has-text("Apply")',
    'button:has-text("Apply")',
    'button:has-text("Solicitar")',
    'a:has-text("Solicitar")',
    'button:has-text("Bewerben")',
    'a:has-text("Bewerben")',
    'button:has-text("Postuler")',
    'a[href*="greenhouse.io"]',
    'a[href*="lever.co"]',
    'a[href*="ashbyhq.com"]',
    'a[href*="smartrecruiters.com"]',
  ];
  for (const sel of candidates) {
    const el = await page.$(sel);
    if (el) {
      try {
        await Promise.all([
          page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {}),
          el.click(),
        ]);
        await page.waitForTimeout(2000);
        await dismissOverlays(page);
        if ((await fieldCount()) >= 3) return;
      } catch {
        /* keep trying */
      }
    }
  }
}

function detectPortal(u: string): string {
  if (/greenhouse\.io/.test(u)) return "greenhouse";
  if (/lever\.co/.test(u)) return "lever";
  if (/ashbyhq\.com/.test(u)) return "ashby";
  if (/myworkdayjobs\.com/.test(u)) return "workday";
  if (/successfactors/.test(u)) return "successfactors";
  if (/smartrecruiters/.test(u)) return "smartrecruiters";
  if (/linkedin\.com/.test(u)) return "linkedin";
  return "generic";
}

async function detectStuck(page: Page): Promise<string | null> {
  let text = "";
  try {
    text += (await page.title()) + " ";
  } catch {
    /* ignore */
  }
  try {
    text += await page.evaluate(() => (document.body?.innerText || "").slice(0, 800));
  } catch {
    /* ignore */
  }
  const low = text.toLowerCase();
  const markers = [
    "verification required",
    "just a moment",
    "checking your browser",
    "unusual activity",
    "are you a robot",
    "access denied",
    "attention required",
    "verify you are human",
    "cf-challenge",
    "enable javascript and cookies",
  ];
  for (const m of markers) {
    if (low.includes(m)) return m;
  }
  return null;
}

async function main() {
  const portal = detectPortal(url!);
  let context: BrowserContext;
  let ownsBrowser = true;
  if (cdpPort) {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    context = browser.contexts()[0] ?? (await browser.newContext());
    ownsBrowser = false;
  } else {
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: exe,
      headless: false,
      viewport: { width: 1280, height: 1000 },
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--force-renderer-accessibility"],
    });
  }
  const pages = context.pages();
  const page = pages.find((p) => p.url().startsWith("http")) ?? pages[0] ?? (await context.newPage());
  const result: any = { url, portal, filled: [], unfilled: [], required_unfilled: [], needs_input: [], needs_verify: [], submitted: false };

  try {
    if (verifyCode) {
      // Fill a verification code on the currently open page, without reloading.
      const vfields = (await gatherFields(page)).filter((f) => f.visible);
      const codeField = vfields.find((f) => VERIFY_RE.test(f.descriptor));
      if (codeField) {
        await fillOne(page, codeField, verifyCode);
        result.verified = true;
        result.filled.push({ key: "verify_code", descriptor: codeField.descriptor, value: "****" });
      }
      const btn = await page.$(
        'button[type=submit], button:has-text("Verify"), button:has-text("Confirm"), button:has-text("Continue"), button:has-text("Submit")'
      );
      if (btn) {
        try {
          await btn.click({ timeout: 5000 });
          await page.waitForTimeout(3000);
        } catch {
          /* ignore */
        }
      }
    } else if (!screenshotOnly) {
      if (!noNavigate) {
        await page.goto(url!, { waitUntil: "domcontentloaded", timeout: 60000 });
        await findFormUrl(page, url!);
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2500);
      }

      const stuckReason = await detectStuck(page);
      const fields = (await gatherFields(page)).filter((f) => f.visible);
      if (process.env.HARNESS_FILL_DEBUG) {
        console.error("FIELDS:\n" + JSON.stringify(fields, null, 2));
      }
      if (stuckReason) result.stuck = { reason: stuckReason };
      else if (fields.length < 2) result.stuck = { reason: "no form fields found" };

      // File uploads first (resume / cover).
      const fileFields = result.stuck ? [] : fields.filter((f) => f.type === "file");
      for (const f of fileFields) {
        const d = f.descriptor.toLowerCase();
        let path: string | undefined;
        if (/cover|letter|anschreiben|motivation/.test(d)) path = coverPath;
        else if (/resume|cv|curriculum|lebenslauf|attach/.test(d)) path = cvPath;
        else path = cvPath;
        if (path) {
          try {
            await page.setInputFiles(`[data-harness-idx="${f.idx}"]`, path);
            result.filled.push({ key: "file", descriptor: f.descriptor, value: path });
          } catch {
            result.required_unfilled.push({ key: "file", descriptor: f.descriptor });
          }
        }
      }

      let authForm = false;
      for (const field of result.stuck ? [] : fields) {
        if (field.type === "file") continue;
        if (VERIFY_RE.test(field.descriptor)) {
          result.needs_verify.push({ key: "verify_code", descriptor: field.descriptor });
          continue;
        }
        if (field.type === "password") authForm = true;
        const knownKey = matchKey(field.descriptor);
        const key = knownKey ?? (field.required && isInformative(field.descriptor) ? synthKeyFor(field.descriptor) : undefined);
        if (!key) {
          if (field.required && isInformative(field.descriptor)) {
            result.required_unfilled.push({ key: null, descriptor: field.descriptor });
          } else {
            result.unfilled.push({ descriptor: field.descriptor });
          }
          continue;
        }
        const raw = answers[key];
        // No value yet: @ask keys and unknown required fields get asked.
        if (raw === undefined || raw === "" || raw === "@ask") {
          if (raw === "@ask" || field.required) {
            result.needs_input.push({ key, descriptor: field.descriptor, required: field.required });
          } else {
            result.unfilled.push({ descriptor: field.descriptor });
          }
          continue;
        }
        // Voluntary self-ID: only fill when the field is required.
        if (VOLUNTARY_ONLY.has(key) && !field.required) {
          result.unfilled.push({ descriptor: field.descriptor });
          continue;
        }
        const value = resolveValue(key, raw, field);
        const ok = await fillOne(page, field, value);
        if (ok) result.filled.push({ key, descriptor: field.descriptor, value });
        else if (field.required) result.required_unfilled.push({ key, descriptor: field.descriptor });
      }

      // Auth forms: click the sign-in / create-account button after filling.
      if (authForm) {
        const authBtn = await page.$(
          'button[type=submit], button:has-text("Sign in"), button:has-text("Log in"), ' +
            'button:has-text("Create account"), button:has-text("Create Account"), ' +
            'button:has-text("Sign up"), button:has-text("Register"), button:has-text("Continue")'
        );
        if (authBtn) {
          try {
            await authBtn.click({ timeout: 5000 });
            await page.waitForTimeout(3000);
          } catch {
            /* ignore */
          }
        }
        // The portal may reveal a verification step after the auth action.
        const after = (await gatherFields(page)).filter((f) => f.visible);
        const vf = after.find((f) => VERIFY_RE.test(f.descriptor));
        if (vf && !result.needs_verify.some((n: any) => n.descriptor === vf.descriptor)) {
          result.needs_verify.push({ key: "verify_code", descriptor: vf.descriptor });
        }
      }
    }

    // Drop required_unfilled entries whose key was actually filled elsewhere
    // (react-select renders hidden + visible inputs, producing false gaps).
    const filledKeys = new Set(result.filled.map((f: any) => f.key));
    result.required_unfilled = (result.required_unfilled || []).filter(
      (m: any) => !(m.key && filledKeys.has(m.key))
    );

    mkdirSync(dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    result.screenshot = screenshotPath;

    if (submit) {
      const btn =
        (await page.$('button[type=submit], input[type=submit], button:has-text("Submit"), button:has-text("Apply")')) ?? null;
      if (btn) {
        await btn.click();
        await page.waitForTimeout(4000);
        result.submitted = true;
        await page.screenshot({ path: screenshotPath.replace(/\.png$/, "-after.png"), fullPage: true });
      } else {
        result.submit_error = "no submit button found";
      }
    }
  } catch (err) {
    result.error = (err as Error).message;
  } finally {
    if (ownsBrowser) await context.close();
  }
  const json = JSON.stringify(result, null, 2);
  await new Promise<void>((resolve) => process.stdout.write(json + "\n", () => resolve()));
  // In CDP mode the connection keeps Node alive; exit explicitly.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
