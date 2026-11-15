import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI, Type, Schema } from '@google/genai';
import { chromium, Page } from 'playwright';
import * as crypto from 'crypto';

// 1. Inicializace klientů
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

// Kolik obchodů spojit do JEDNOHO volání Gemini (šetří 80 % denního limitu volání)
const BATCH_SIZE = 5;

// Seznam modelů od nejlepšího po záložní s nejvyššími limity
// Pokud první model hodí 503 (přetíženo) nebo 429 (limit), skript automaticky zkusí další
const MODELS_FALLBACK = [
  'gemini-4-hydrogen',
  'gemini-3.8-flash',
  'gemini-3.8-flash-lite'
];

// 2. Schéma výstupu pro dávku obchodů (každý kupón má přiřazené store_id)
const batchCouponResponseSchema: Schema = {
  type: Type.ARRAY,
  description: 'Seznam nalezených slevových kupónů ze všech kontrolovaných obchodů v dávce.',
  items: {
    type: Type.OBJECT,
    properties: {
      store_id: {
        type: Type.STRING,
        description: 'Přesné ID obchodu (STORE_ID), ke kterému tento kupón patří.'
      },
      kod: {
        type: Type.STRING,
        description: 'Slevový kód (např. SLEVA20). Vždy velkými písmeny bez mezer.'
      },
      popis: {
        type: Type.STRING,
        description: 'Stručný název/popis slevy (např. Sleva 20 % na vše).'
      },
      sleva_hodnota: {
        type: Type.STRING,
        description: 'Hodnota slevy (např. "20 %", "200 Kč", "Doprava zdarma").'
      },
      podminky: {
        type: Type.STRING,
        description: 'Detailní podmínky uplatnění (minimální objednávka, výjimky, na jaké produkty platí).'
      },
      platnost_od: {
        type: Type.STRING,
        description: 'Datum začátku platnosti YYYY-MM-DD (pokud je uvedeno, jinak prázdný řetězec).'
      },
      platnost_do: {
        type: Type.STRING,
        description: 'Datum konce platnosti YYYY-MM-DD (přepočítej i z odpočtů, jinak prázdný řetězec).'
      },
      pro_nove_zakazniky: {
        type: Type.BOOLEAN,
        description: 'True, pokud jde o kód pouze na první nákup nebo za newsletter.'
      },
      zdroj_url: {
        type: Type.STRING,
        description: 'URL adresa, kde byl kód nalezen.'
      }
    },
    required: ['store_id', 'kod', 'popis', 'sleva_hodnota', 'podminky', 'pro_nove_zakazniky', 'zdroj_url']
  }
};

// 3. Vytažení textu, horních lišt a screenshotu z jedné stránky
async function scrapePageData(page: Page, url: string, takeScreenshot = false): Promise<{ text: string; screenshotBase64?: string }> {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 35000 }).catch(() => {});
    await page.waitForTimeout(4000);

    // Odkliknutí cookie lišty
    try {
      const cookieSelectors = [
        'button:has-text("Přijmout")',
        'button:has-text("Souhlasím")',
        'button:has-text("Povolit vše")',
        'button:has-text("Povolit")',
        'a:has-text("Rozumím")',
        '#cookiescript_accept',
        '.c-button--accept'
      ];
      for (const sel of cookieSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 400 })) {
          await btn.click({ timeout: 1000 });
          await page.waitForTimeout(1000);
          break;
        }
      }
    } catch {}

    let screenshotBase64: string | undefined = undefined;
    if (takeScreenshot) {
      const buffer = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: false });
      screenshotBase64 = buffer.toString('base64');
    }

    // Text z případných iframe (promo lišty)
    let iframeTexts = '';
    for (const frame of page.frames()) {
      try {
        if (frame !== page.mainFrame()) {
          const ft = await frame.evaluate(() => document.body?.innerText || '');
          if (ft.trim().length > 5) {
            iframeTexts += `\n[IFRAME LIŠTA]: ${ft.replace(/\s+/g, ' ').trim()}`;
          }
        }
      } catch {}
    }

    const extractedData = await page.evaluate(() => {
      const visibleText = document.body.innerText || '';

      // Horní lišty a bannery
      const topBarTexts: string[] = [];
      document.querySelectorAll('header, [class*="top"], [class*="bar"], [class*="strip"], [class*="ribbon"], [class*="info"], [class*="promo"], [class*="banner"], [id*="bar"], [id*="top"]').forEach((el) => {
        const t = el.textContent?.replace(/\s+/g, ' ').trim();
        if (t && t.length > 3 && t.length < 600) {
          topBarTexts.push(t);
        }
      });

      // Popisky obrázků (alt, title)
      const imageTexts: string[] = [];
      document.querySelectorAll('img, picture, [role="img"], a').forEach((el) => {
        const alt = el.getAttribute('alt');
        const title = el.getAttribute('title');
        if (alt && alt.trim().length > 2) imageTexts.push(`[ALT]: ${alt.trim()}`);
        if (title && title.trim().length > 2) imageTexts.push(`[TITLE]: ${title.trim()}`);
      });

      return {
        topBarsPreview: Array.from(new Set(topBarTexts)).slice(0, 6).join(' || '),
        full: `
          === HORNÍ LIŠTY A BANNERY ===
          ${Array.from(new Set(topBarTexts)).join('\n').slice(0, 5000)}

          === POPISKY OBRÁZKŮ (ALT/TITLE) ===
          ${Array.from(new Set(imageTexts)).join('\n').slice(0, 4000)}

          === VIDITELNÝ TEXT STRÁNKY ===
          ${visibleText.slice(0, 15000)}
        `
      };
    });

    if (takeScreenshot) {
      console.log(`   🔝 Horní lišty na webu: ${extractedData.topBarsPreview.slice(0, 350)}`);
    }

    return {
      text: `\n--- ZDROJOVÁ ADRESA: ${url} ---\n` + extractedData.full + iframeTexts,
      screenshotBase64
    };
  } catch (err) {
    console.warn(`⚠️ Nepodařilo se načíst URL ${url}:`, err);
    return { text: '' };
  }
}

// 4. Volání Gemini s automatickým přepínáním modelů a opakováním při 503/429
async function callGeminiWithFallback(contentsParts: any[]): Promise<any[]> {
  for (const modelName of MODELS_FALLBACK) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: contentsParts,
          config: {
            responseMimeType: 'application/json',
            responseSchema: batchCouponResponseSchema,
            temperature: 0.1
          }
        });
        return JSON.parse(response.text || '[]');
      } catch (err: any) {
        const status = err?.status || err?.code;
        console.warn(`   ⚠️ Model ${modelName} (pokus ${attempt}/3) vrátil chybu ${status}: ${err?.message?.slice(0, 120)}`);

        if (status === 503 || status === 429) {
          // Počkáme 12 vteřin a zkusíme znovu
          await new Promise((r) => setTimeout(r, 12000));
        } else {
          // Pokud model neexistuje (404), jdeme rovnou na další model v seznamu
          break;
        }
      }
    }
  }
  throw new Error('Všechny modely Gemini selhaly nebo jsou dočasně nedostupné.');
}

// 5. Hlavní funkce sběrače
async function runScraper() {
  const today = new Date().toISOString().split('T')[0];
  console.log(`🚀 Spouštím dávkový sběrač kupónů (${today})...`);

  const { data: stores, error } = await supabase
    .from('obchody_trhy')
    .select('*')
    .eq('povolene_kupony', true)
    .eq('scraping_aktivni', true)
    .not('webova_adresa', 'is', null);

  if (error || !stores) {
    console.error('❌ Chyba při načítání obchodů ze Supabase:', error);
    process.exit(1);
  }

  console.log(`📋 Nalezeno ${stores.length} aktivních obchodů ke kontrole.`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'cs-CZ',
    timezoneId: 'Europe/Prague',
    extraHTTPHeaders: {
      'Accept-Language': 'cs-CZ,cs;q=0.9,sk;q=0.8,en;q=0.7'
    }
  });

  // FÁZE 1: Stažení dat z webů a filtrace změn
  interface PreparedStore {
    store: any;
    combinedContent: string;
    screenshotBase64?: string;
    currentHash: string;
  }

  const storesForAi: PreparedStore[] = [];

  for (const store of stores) {
    const storeLabel = store.obchod_slug || store.nazev || store.webova_adresa;

    if (store.preskocit_kontrolu_do && store.preskocit_kontrolu_do > today) {
      console.log(`⏭️ Přeskakuji ${storeLabel} - chytrá pauza do ${store.preskocit_kontrolu_do}`);
      continue;
    }

    console.log(`🔍 Stahuji web: ${storeLabel} -> ${store.webova_adresa}`);
    const page = await context.newPage();

    try {
      const mainData = await scrapePageData(page, store.webova_adresa, true);
      const combinedContent = mainData.text;
      const currentHash = crypto.createHash('md5').update(combinedContent).digest('hex');

      if (store.posledni_hash_obsahu === currentHash) {
        console.log(`   🟰 Obsah webu se od minula nezměnil, šetřím AI limit.`);
        await supabase
          .from('obchody_trhy')
          .update({ posledni_kontrola_webu: new Date().toISOString() })
          .eq('id', store.id);
      } else {
        storesForAi.push({
          store,
          combinedContent,
          screenshotBase64: mainData.screenshotBase64,
          currentHash
        });
      }
    } catch (err) {
      console.error(`❌ Chyba při stahování ${storeLabel}:`, err);
    } finally {
      await page.close();
    }
  }

  await browser.close();

  if (storesForAi.length === 0) {
    console.log('✨ Žádný obchod nevyžaduje AI analýzu. Hotovo!');
    return;
  }

  // FÁZE 2: Zpracování přes Gemini po dávkách (BATCH_SIZE obchodů v 1 dotazu)
  console.log(`🧠 Posílám ${storesForAi.length} obchodů do Gemini v dávkách po ${BATCH_SIZE}...`);

  for (let i = 0; i < storesForAi.length; i += BATCH_SIZE) {
    const batch = storesForAi.slice(i, i + BATCH_SIZE);
    console.log(`\n📦 Zpracovávám dávku ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} obchodů)...`);

    const contentsParts: any[] = [];
    let batchPrompt = `
      Jsi expert na extrakci slevových kupónů z e-shopů. Dnešní datum je ${today}.
      Níže dostaneš data a screenshoty pro ${batch.length} různých e-shopů.
      Pro každý e-shop pozorně prohlédni jeho SCREENSHOT (zejména úplně horní barevnou lištu nad menu a hlavní grafický banner!) a vytažený text.
      
      PŘÍSNÁ PRAVIDLA:
      1. Najdi VŠECHNY platné slevové kupóny, které obsahují konkrétní slevový kód pro zadání v košíku.
      2. U každého nalezeného kupónu MUSÍŠ vyplnit přesné "store_id" obchodu, ke kterému patří.
      3. Ignoruj běžné slevy bez kódu. Nikdy si kódy nevymýšlej.
      4. Pokud je u kupónu odpočet nebo datum konce akce, přepočítej ho od dnešního data (${today}) na formát YYYY-MM-DD do pole platnost_do.
    `;

    contentsParts.push({ text: batchPrompt });

    for (const item of batch) {
      const s = item.store;
      contentsParts.push({
        text: `\n========================================\nOBCHOD STORE_ID: "${s.id}" (URL: ${s.webova_adresa})\n========================================\n${item.combinedContent.slice(0, 25000)}`
      });
      if (item.screenshotBase64) {
        contentsParts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: item.screenshotBase64
          }
        });
      }
    }

    try {
      const foundCoupons = await callGeminiWithFallback(contentsParts);
      console.log(`   🤖 Gemini v této dávce nalezlo celkem ${foundCoupons.length} kupónů:`, JSON.stringify(foundCoupons));

      // Rozřadíme nalezené kupóny k jednotlivým obchodům v dávce
      for (const item of batch) {
        const s = item.store;
        const storeCoupons = foundCoupons.filter((c: any) => String(c.store_id) === String(s.id));
        let latestExpiration: string | null = null;

        for (const coupon of storeCoupons) {
          const cleanCode = coupon.kod.trim().toUpperCase();

          const { data: existingApproved } = await supabase
            .from('kupony')
            .select('id')
            .eq('obchod_trh_id', s.id)
            .ilike('kod', cleanCode)
            .maybeSingle();

          const { data: existingQueue } = await supabase
            .from('kupony_ke_schvaleni')
            .select('id')
            .eq('obchod_trh_id', s.id)
            .ilike('kod', cleanCode)
            .maybeSingle();

          if (!existingApproved && !existingQueue) {
            const { error: insertErr } = await supabase.from('kupony_ke_schvaleni').insert({
              obchod_trh_id: s.id,
              kod: cleanCode,
              popis: coupon.popis,
              sleva_hodnota: coupon.sleva_hodnota,
              podminky: coupon.podminky,
              platnost_od: coupon.platnost_od || null,
              platnost_do: coupon.platnost_do || null,
              pro_nove_zakazniky: coupon.pro_nove_zakazniky,
              zdroj_typ: 'automat_web',
              zdroj_info: coupon.zdroj_url || s.webova_adresa,
              ai_jistota: 95,
              stav: 'ceka',
              surova_data: coupon
            });
            if (insertErr) {
              console.error(`   ❌ Chyba zápisu do DB u kódu ${cleanCode}:`, insertErr);
            } else {
              console.log(`   ✅ Uložen nový kupón ke schválení: ${cleanCode} (${coupon.sleva_hodnota})`);
            }
          } else {
            console.log(`   ℹ️ Kupón ${cleanCode} už v databázi existuje.`);
          }

          if (coupon.platnost_do && (!latestExpiration || coupon.platnost_do > latestExpiration)) {
            latestExpiration = coupon.platnost_do;
          }
        }

        // Uložíme nový hash a datum kontroly až po úspěšném vyhodnocení AI
        await supabase
          .from('obchody_trhy')
          .update({
            posledni_kontrola_webu: new Date().toISOString(),
            posledni_hash_obsahu: item.currentHash,
            preskocit_kontrolu_do: latestExpiration
          })
          .eq('id', s.id);
      }

      // Krátká pauza 6 vteřin mezi dávkami, abychom nikdy nepřekročili minutový limit (RPM)
      if (i + BATCH_SIZE < storesForAi.length) {
        await new Promise((r) => setTimeout(r, 6000));
      }
    } catch (batchErr) {
      console.error(`❌ Chyba při zpracování dávky v AI:`, batchErr);
    }
  }

  console.log('\n🎉 Kontrola všech obchodů úspěšně dokončena!');
}

runScraper();
