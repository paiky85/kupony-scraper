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

// Seznam modelů s automatickým přepínáním (Fallback)
const MODELS_FALLBACK = [
  'gemini-4-hydrogen',
  'gemini-3.8-flash',
  'gemini-3.8-flash-lite'
];

// Povolené typy slev přesně podle CHECK constraintu v databázi
const NUMERIC_DISCOUNT_TYPES = ['procento', 'CZK', 'EUR', 'USD', 'PLN', 'GBP', 'HUF'];
const NULL_VALUE_DISCOUNT_TYPES = ['doprava_zdarma', 'darek', 'akce_1plus1', 'jina_akce'];
const ALL_DISCOUNT_TYPES = [...NUMERIC_DISCOUNT_TYPES, ...NULL_VALUE_DISCOUNT_TYPES];

// 2. Schéma výstupu pro dávku obchodů
const batchCouponResponseSchema: Schema = {
  type: Type.ARRAY,
  description: 'Seznam nalezených slevových kupónů ze všech kontrolovaných obchodů v dávce.',
  items: {
    type: Type.OBJECT,
    properties: {
      store_key: {
        type: Type.STRING,
        description: 'Přesný klíč obchodu (STORE_KEY) z hlavičky, např. "chia-shake|CZ".'
      },
      kod: {
        type: Type.STRING,
        description: 'Slevový kód (např. BF15CZ). Vždy velkými písmeny bez mezer.'
      },
      nadpis: {
        type: Type.STRING,
        description: 'Stručný a jasný hlavní název akce (např. "Black Friday sleva 15 % na vše" nebo "Doprava zdarma nad 1 000 Kč").'
      },
      sleva_typ: {
        type: Type.STRING,
        enum: ALL_DISCOUNT_TYPES,
        description: 'Typ slevy: "procento" pro % slevy, kód měny ("CZK", "EUR", "PLN"...) pro peněžní slevy, nebo "doprava_zdarma", "darek", "akce_1plus1", "jina_akce".'
      },
      sleva_hodnota: {
        type: Type.NUMBER,
        description: 'Číselná hodnota slevy (např. 15 pro 15 %, nebo 200 pro 200 Kč). Pokud je sleva_typ doprava_zdarma, darek, akce_1plus1 nebo jina_akce, vrať 0.'
      },
      popis: {
        type: Type.STRING,
        description: 'Doplňující podmínky uplatnění (např. minimální hodnota nákupu, výjimky na zlevněné zboží, zda platí jen pro nové zákazníky/newsletter). Pokud žádné další podmínky nejsou, nech prázdný řetězec.'
      },
      raw_text_z_webu: {
        type: Type.STRING,
        description: 'Doslovný text z banneru nebo stránky, ze kterého byl kupón vyčten (pro kontrolu v administraci).'
      },
      plati_od: {
        type: Type.STRING,
        description: 'Datum začátku platnosti YYYY-MM-DD (pokud je uvedeno, jinak prázdný řetězec).'
      },
      plati_do: {
        type: Type.STRING,
        description: 'Datum konce platnosti YYYY-MM-DD (přepočítej i z odpočtů typu "končí za 2 dny", jinak prázdný řetězec).'
      },
      cilova_url: {
        type: Type.STRING,
        description: 'URL adresa stránky nebo podstránky, kde byl kód nalezen.'
      }
    },
    required: [
      'store_key',
      'kod',
      'nadpis',
      'sleva_typ',
      'sleva_hodnota',
      'popis',
      'raw_text_z_webu',
      'plati_od',
      'plati_do',
      'cilova_url'
    ]
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
        '.c-button--accept',
        '[data-testid="uc-accept-all-button"]'
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

      const topBarTexts: string[] = [];
      document.querySelectorAll('header, [class*="top"], [class*="bar"], [class*="strip"], [class*="ribbon"], [class*="info"], [class*="promo"], [class*="banner"], [id*="bar"], [id*="top"]').forEach((el) => {
        const t = el.textContent?.replace(/\s+/g, ' ').trim();
        if (t && t.length > 3 && t.length < 600) {
          topBarTexts.push(t);
        }
      });

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
      console.log(`   🔝 Horní lišty na webu: ${extractedData.topBarsPreview.slice(0, 300)}`);
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

// 4. Automatické nalezení podstránek se slevami v menu/patičce
async function findPromoSubpages(page: Page, baseUrl: string): Promise<string[]> {
  try {
    const baseHost = new URL(baseUrl).hostname;
    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href]')).map((a) => ({
        href: (a as HTMLAnchorElement).href,
        text: (a.textContent || '').toLowerCase()
      }));
    });

    const keywords = [
      'kupon', 'kupón', 'slevov', 'voucher', 'akce', 'akcni', 'akční',
      'vyprodej', 'výprodej', 'black-friday', 'slevy', 'promo', 'kod', 'kód'
    ];

    const foundUrls = new Set<string>();
    for (const link of links) {
      try {
        const u = new URL(link.href);
        if (u.hostname === baseHost && u.pathname !== '/' && !u.pathname.match(/\.(jpg|png|pdf|xml)$/i)) {
          const combined = (u.pathname + ' ' + link.text).toLowerCase();
          if (keywords.some((kw) => combined.includes(kw))) {
            foundUrls.add(u.origin + u.pathname);
          }
        }
      } catch {}
    }

    return Array.from(foundUrls).slice(0, 2);
  } catch {
    return [];
  }
}

// 5. Volání Gemini s automatickým přepínáním modelů a opakováním při 503/429
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
          await new Promise((r) => setTimeout(r, 12000));
        } else {
          break;
        }
      }
    }
  }
  throw new Error('Všechny modely Gemini selhaly nebo jsou dočasně nedostupné.');
}

// 6. Hlavní funkce sběrače
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

  interface PreparedStore {
    store: any;
    storeKey: string; // např. "chia-shake|CZ"
    combinedContent: string;
    screenshotBase64?: string;
    currentHash: string;
  }

  const storesForAi: PreparedStore[] = [];

  for (const store of stores) {
    const storeKey = `${store.obchod_id}|${store.kod_zeme}`;
    const storeLabel = `${store.lokalni_nazev || store.obchod_id} (${store.kod_zeme})`;

    if (store.preskocit_kontrolu_do && store.preskocit_kontrolu_do > today) {
      console.log(`⏭️ Přeskakuji ${storeLabel} - chytrá pauza do ${store.preskocit_kontrolu_do}`);
      continue;
    }

    console.log(`🔍 Stahuji web: ${storeLabel} -> ${store.webova_adresa}`);
    const page = await context.newPage();

    try {
      const mainData = await scrapePageData(page, store.webova_adresa, true);
      let combinedContent = mainData.text;

      // Kontrola případných podstránek (max 2 automatické + ručně zadané v dalsi_url_ke_kontrole)
      const autoSubpages = await findPromoSubpages(page, store.webova_adresa);
      const manualSubpages: string[] = Array.isArray(store.dalsi_url_ke_kontrole) ? store.dalsi_url_ke_kontrole : [];
      const allSubpages = Array.from(new Set([...manualSubpages, ...autoSubpages])).slice(0, 3);

      for (const subUrl of allSubpages) {
        console.log(`   ↳ Procházím podstránku: ${subUrl}`);
        const subData = await scrapePageData(page, subUrl, false);
        combinedContent += subData.text;
      }

      const currentHash = crypto.createHash('md5').update(combinedContent).digest('hex');

      if (store.posledni_hash_obsahu === currentHash) {
        console.log(`   🟰 Obsah webu se od minula nezměnil, šetřím AI limit.`);
        await supabase
          .from('obchody_trhy')
          .update({ posledni_kontrola_at: new Date().toISOString() })
          .eq('obchod_id', store.obchod_id)
          .eq('kod_zeme', store.kod_zeme);
      } else {
        storesForAi.push({
          store,
          storeKey,
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

  console.log(`🧠 Posílám ${storesForAi.length} obchodů do Gemini v dávkách po ${BATCH_SIZE}...`);

  for (let i = 0; i < storesForAi.length; i += BATCH_SIZE) {
    const batch = storesForAi.slice(i, i + BATCH_SIZE);
    console.log(`\n📦 Zpracovávám dávku ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} obchodů)...`);

    const contentsParts: any[] = [];
    const batchPrompt = `
      Jsi expert na extrakci slevových kupónů z e-shopů. Dnešní datum je ${today}.
      Níže dostaneš data a screenshoty pro ${batch.length} různých e-shopů.
      Pro každý e-shop pozorně prohlédni jeho SCREENSHOT (zejména úplně horní barevnou lištu nad menu a hlavní grafický banner!) a vytažený text.
      
      PŘÍSNÁ PRAVIDLA:
      1. Najdi VŠECHNY platné slevové kupóny, které obsahují konkrétní slevový kód pro zadání v košíku.
      2. U každého nalezeného kupónu MUSÍŠ vyplnit přesný "store_key" obchodu z hlavičky OBCHOD STORE_KEY (např. "chia-shake|CZ").
      3. Pole "nadpis" musí být stručný a výstižný název slevy (např. "Black Friday sleva 15 % na vše").
      4. Pole "popis" obsahuje pouze doplňující podmínky (např. "Platí při nákupu nad 1 000 Kč." nebo "Platí pro nové zákazníky."). Pokud žádné speciální podmínky nejsou, nech "popis" jako prázdný řetězec "".
      5. Pro procentuální slevu nastav sleva_typ="procento" a sleva_hodnota=číslo (např. 15). Pro peněžní slevu nastav sleva_typ podle měny obchodu ("CZK", "EUR"...) a sleva_hodnota=částka. Pro dopravu zdarma, dárek nebo 1+1 nastav příslušný sleva_typ a sleva_hodnota=0.
      6. Pokud je u kupónu odpočet nebo datum konce akce, přepočítej ho od dnešního data (${today}) na formát YYYY-MM-DD do pole plati_do.
    `;

    contentsParts.push({ text: batchPrompt });

    for (const item of batch) {
      contentsParts.push({
        text: `\n========================================\nOBCHOD STORE_KEY: "${item.storeKey}" (Název: ${item.store.lokalni_nazev}, Měna obchodu: ${item.store.mena || 'CZK'}, URL: ${item.store.webova_adresa})\n========================================\n${item.combinedContent.slice(0, 25000)}`
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

      for (const item of batch) {
        const s = item.store;
        const storeCoupons = batch.length === 1
          ? foundCoupons
          : foundCoupons.filter((c: any) => String(c.store_key) === item.storeKey);

        let latestExpiration: string | null = null;

        for (const coupon of storeCoupons) {
          const cleanCode = coupon.kod.trim().toUpperCase();

          // 1. Kontrola duplicity v ostré tabulce "kupony"
          const { data: existingApproved } = await supabase
            .from('kupony')
            .select('id')
            .eq('obchod_id', s.obchod_id)
            .eq('kod_zeme', s.kod_zeme)
            .ilike('kod', cleanCode)
            .is('smazano_at', null)
            .maybeSingle();

          // 2. Kontrola duplicity v čekací tabulce "kupony_ke_schvaleni"
          const { data: existingQueue } = await supabase
            .from('kupony_ke_schvaleni')
            .select('id')
            .eq('obchod_id', s.obchod_id)
            .eq('kod_zeme', s.kod_zeme)
            .ilike('kod', cleanCode)
            .maybeSingle();

          if (!existingApproved && !existingQueue) {
            // Ošetření CHECK constraintu check_inbox_sleva_logika:
            let slevaTyp = ALL_DISCOUNT_TYPES.includes(coupon.sleva_typ) ? coupon.sleva_typ : 'jina_akce';
            let slevaHodnota: number | null = null;

            if (NUMERIC_DISCOUNT_TYPES.includes(slevaTyp)) {
              const numVal = Number(coupon.sleva_hodnota);
              if (!isNaN(numVal) && numVal > 0) {
                slevaHodnota = numVal;
              } else {
                // Pokud AI vrátila 0 nebo nečíselnou hodnotu u procenta/měny, přepneme na jina_akce s NULL
                slevaTyp = 'jina_akce';
                slevaHodnota = null;
              }
            } else {
              // Pro doprava_zdarma, darek, akce_1plus1, jina_akce MUSÍ být sleva_hodnota NULL
              slevaHodnota = null;
            }

            const payload = {
              obchod_id: s.obchod_id,
              kod_zeme: s.kod_zeme,
              kod: cleanCode,
              nadpis: coupon.nadpis || `Slevový kód ${cleanCode}`,
              sleva_hodnota: slevaHodnota,
              sleva_typ: slevaTyp,
              popis: coupon.popis && coupon.popis.trim().length > 0 ? coupon.popis.trim() : null,
              plati_od: coupon.plati_od && coupon.plati_od.length === 10 ? coupon.plati_od : null,
              plati_do: coupon.plati_do && coupon.plati_do.length === 10 ? coupon.plati_do : null,
              cilova_url: coupon.cilova_url || s.webova_adresa,
              zdroj: 'automat_web',
              stav: 'ceka',
              raw_data: coupon
            };

            const { error: insertErr } = await supabase
              .from('kupony_ke_schvaleni')
              .insert(payload);

            if (insertErr) {
              console.error(`   ❌ Chyba zápisu do DB u kódu ${cleanCode}:`, insertErr);
            } else {
              console.log(`   ✅ Uložen nový kupón ke schválení: ${cleanCode} (${slevaHodnota ?? ''} ${slevaTyp}) pro ${item.storeKey}`);
            }
          } else {
            console.log(`   ℹ️ Kupón ${cleanCode} (${item.storeKey}) už v databázi existuje, přeskakuji.`);
          }

          if (coupon.plati_do && coupon.plati_do.length === 10 && (!latestExpiration || coupon.plati_do > latestExpiration)) {
            latestExpiration = coupon.plati_do;
          }
        }

        // Uložíme nový hash a datum kontroly do tabulky obchody_trhy
        await supabase
          .from('obchody_trhy')
          .update({
            posledni_kontrola_at: new Date().toISOString(),
            posledni_hash_obsahu: item.currentHash,
            preskocit_kontrolu_do: s.pauza_pri_aktivnim_kuponu ? latestExpiration : null
          })
          .eq('obchod_id', s.obchod_id)
          .eq('kod_zeme', s.kod_zeme);
      }

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
