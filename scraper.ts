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

// 2. Schéma výstupu pro Gemini
const couponResponseSchema: Schema = {
  type: Type.ARRAY,
  description: 'Seznam nalezených slevových kupónů s konkrétním kódem.',
  items: {
    type: Type.OBJECT,
    properties: {
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
        description: 'Detailní podmínky uplatnění (minimální objednávka, výjimky na zlevněné zboží, na jaké značky platí).'
      },
      platnost_od: {
        type: Type.STRING,
        description: 'Datum začátku platnosti ve formátu YYYY-MM-DD (pokud je uvedeno, jinak prázdný řetězec).'
      },
      platnost_do: {
        type: Type.STRING,
        description: 'Datum konce platnosti ve formátu YYYY-MM-DD (přepočítej i z odpočtů typu "končí za 2 dny" nebo z JSON dat, jinak prázdný řetězec).'
      },
      pro_nove_zakazniky: {
        type: Type.BOOLEAN,
        description: 'True, pokud jde o kód pouze na první nákup nebo za registraci do newsletteru.'
      },
      zdroj_url: {
        type: Type.STRING,
        description: 'Konkrétní URL adresa podstránky, kde byl kód nalezen.'
      }
    },
    required: ['kod', 'popis', 'sleva_hodnota', 'podminky', 'pro_nove_zakazniky', 'zdroj_url']
  }
};

// 3. Funkce pro vytažení dat z jedné stránky (včetně popisků obrázků a volitelného screenshotu)
async function scrapePageData(page: Page, url: string, takeScreenshot = false): Promise<{ text: string; screenshotBase64?: string }> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Počkáme 4 vteřiny, aby stihly naskočit i opožděné horní lišty, bannery a pop-upy
    await page.waitForTimeout(4000);

    // Zkusíme odkliknout běžné cookie lišty, aby nezakrývaly banner na screenshotu
    try {
      const cookieSelectors = [
        'button:has-text("Přijmout")',
        'button:has-text("Souhlasím")',
        'button:has-text("Povolit vše")',
        'a:has-text("Rozumím")',
        '#cookiescript_accept',
        '.c-button--accept'
      ];
      for (const sel of cookieSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 500 })) {
          await btn.click({ timeout: 1000 });
          await page.waitForTimeout(500);
          break;
        }
      }
    } catch {
      // Ignorujeme, pokud cookie lišta nejde odkliknout
    }

    let screenshotBase64: string | undefined = undefined;
    if (takeScreenshot) {
      const buffer = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: false });
      screenshotBase64 = buffer.toString('base64');
    }

    const extractedData = await page.evaluate(() => {
      // A) Běžný viditelný text
      const visibleText = document.body.innerText || '';

      // B) Popisky ze všech obrázků a bannerů (alt, title, aria-label)
      const imageTexts: string[] = [];
      document.querySelectorAll('img, [role="img"], .banner, .carousel, .slider, [class*="banner"], [class*="promo"], [class*="topbar"], [class*="header-bar"]').forEach((el) => {
        const alt = el.getAttribute('alt');
        const title = el.getAttribute('title');
        const aria = el.getAttribute('aria-label');
        if (alt && alt.trim().length > 3) imageTexts.push(`[ALT obrázku]: ${alt.trim()}`);
        if (title && title.trim().length > 3) imageTexts.push(`[TITLE prvku]: ${title.trim()}`);
        if (aria && aria.trim().length > 3) imageTexts.push(`[ARIA prvku]: ${aria.trim()}`);
      });

      // C) Skryté texty (modaly, detaily kupónů, pop-upy, které mají display:none)
      const hiddenElements = document.querySelectorAll(
        '[class*="modal"], [class*="popup"], [class*="tooltip"], [class*="condition"], [class*="podmink"], [class*="detail"], [class*="banner"], [class*="kupon"], [class*="coupon"], [id*="modal"], [id*="popup"]'
      );
      let hiddenText = '';
      hiddenElements.forEach((el) => {
        const t = el.textContent?.replace(/\s+/g, ' ').trim();
        if (t && t.length > 10 && t.length < 2000) {
          hiddenText += t + '\n';
        }
      });

      // D) Časovače a data platnosti v atributech
      const timers: string[] = [];
      document.querySelectorAll('[data-countdown], [data-end], [data-expire], [data-until], [data-date], time[datetime]').forEach((el) => {
        timers.push(el.outerHTML.slice(0, 300));
      });

      // E) Skryté JSON objekty v kódu (Next.js, Nuxt, Shoptet dataLayer)
      const scripts: string[] = [];
      document.querySelectorAll('script[type="application/ld+json"], script#__NEXT_DATA__').forEach((s) => {
        if (s.textContent) scripts.push(s.textContent.slice(0, 5000));
      });

      return `
        === VIDITELNÝ TEXT ===
        ${visibleText.slice(0, 20000)}

        === POPISKY OBRÁZKŮ A BANNERŮ ===
        ${Array.from(new Set(imageTexts)).join('\n').slice(0, 5000)}

        === SKRYTÉ PODMÍNKY A MODALY ===
        ${hiddenText.slice(0, 8000)}

        === ČASOVAČE A ODPOČTY V HTML ===
        ${timers.join('\n').slice(0, 3000)}

        === STRUKTUROVANÁ DATA (JSON) ===
        ${scripts.join('\n').slice(0, 5000)}
      `;
    });

    return {
      text: `\n--- ZDROJOVÁ ADRESA: ${url} ---\n` + extractedData,
      screenshotBase64
    };
  } catch (err) {
    console.warn(`⚠️ Nepodařilo se načíst URL ${url}:`, err);
    return { text: '' };
  }
}

// 4. Funkce pro automatické nalezení podstránek se slevami v menu/patičce
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
      } catch {
        // Neplatná URL
      }
    }

    return Array.from(foundUrls).slice(0, 2);
  } catch {
    return [];
  }
}

// 5. Hlavní funkce sběrače
async function runScraper() {
  const today = new Date().toISOString().split('T')[0];
  console.log(`🚀 Spouštím sběrač kupónů (${today})...`);

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
    viewport: { width: 1440, height: 900 }
  });

  for (const store of stores) {
    if (store.preskocit_kontrolu_do && store.preskocit_kontrolu_do > today) {
      console.log(`⏭️ Přeskakuji ${store.obchod_slug} (${store.trh_kod}) - chytrá pauza do ${store.preskocit_kontrolu_do}`);
      continue;
    }

    console.log(`🔍 Kontroluji: ${store.obchod_slug} (${store.trh_kod}) -> ${store.webova_adresa}`);
    const page = await context.newPage();

    try {
      // A) Stáhneme hlavní stránku VČETNĚ SCREENSHOTU bannerů
      const mainData = await scrapePageData(page, store.webova_adresa, true);
      let combinedContent = mainData.text;

      // B) Najdeme podstránky
      const autoSubpages = await findPromoSubpages(page, store.webova_adresa);
      const manualSubpages: string[] = Array.isArray(store.dalsi_url_ke_kontrole) ? store.dalsi_url_ke_kontrole : [];
      const allSubpages = Array.from(new Set([...manualSubpages, ...autoSubpages])).slice(0, 3);

      for (const subUrl of allSubpages) {
        console.log(`   ↳ Procházím podstránku: ${subUrl}`);
        const subData = await scrapePageData(page, subUrl, false);
        combinedContent += subData.text;
      }

      // C) Spočítáme hash obsahu
      const currentHash = crypto.createHash('md5').update(combinedContent).digest('hex');

      if (store.posledni_hash_obsahu === currentHash) {
        console.log(`   🟰 Obsah webu se nezměnil, přeskakuji volání AI.`);
        await supabase
          .from('obchody_trhy')
          .update({ posledni_kontrola_webu: new Date().toISOString() })
          .eq('id', store.id);
        await page.close();
        continue;
      }

      // D) Volání Gemini (posíláme text + screenshot hlavní stránky s bannery)
      const prompt = `
        Jsi expert na extrakci slevových kupónů z e-shopů. Dnešní datum je ${today}.
        Analyzuj přiložený SCREENSHOT hlavní stránky (kde mohou být slevové kódy v grafických bannerech nebo horních lištách) a také vytažený obsah z e-shopu "${store.obchod_slug}" (trh: ${store.trh_kod}).
        
        Tvým úkolem je najít VŠECHNY platné slevové kupóny, které mají konkrétní slevový kód (např. v grafickém banneru, v horní liště, v textu, v pop-upu).
        
        PŘÍSNÁ PRAVIDLA:
        1. Hledej POUZE akce, které obsahují konkrétní textový kód pro zadání v košíku (např. "CHIA10", "PODZIM20"). Pozorně přečti i text v obrázkovém banneru na screenshotu!
        2. Ignoruj běžné výprodeje a slevy, které žádný kód nevyžadují.
        3. Nikdy si slevové kódy nevymýšlej.
        4. Pokud je u kupónu odpočet (např. "končí za 3 dny"), přepočítej ho od dnešního data (${today}) na formát YYYY-MM-DD do pole platnost_do.
        
        DATA Z WEBU:
        ${combinedContent.slice(0, 45000)}
      `;

      const contentsParts: any[] = [{ text: prompt }];
      if (mainData.screenshotBase64) {
        contentsParts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: mainData.screenshotBase64
          }
        });
      }

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: contentsParts,
        config: {
          responseMimeType: 'application/json',
          responseSchema: couponResponseSchema,
          temperature: 0.1
        }
      });

      const foundCoupons = JSON.parse(response.text || '[]');
      console.log(`   🤖 Gemini nalezlo ${foundCoupons.length} kupónů.`);

      // E) Uložení do kupony_ke_schvaleni
      let latestExpiration: string | null = null;

      for (const coupon of foundCoupons) {
        const cleanCode = coupon.kod.trim().toUpperCase();

        const { data: existingApproved } = await supabase
          .from('kupony')
          .select('id')
          .eq('obchod_trh_id', store.id)
          .ilike('kod', cleanCode)
          .maybeSingle();

        const { data: existingQueue } = await supabase
          .from('kupony_ke_schvaleni')
          .select('id')
          .eq('obchod_trh_id', store.id)
          .ilike('kod', cleanCode)
          .maybeSingle();

        if (!existingApproved && !existingQueue) {
          await supabase.from('kupony_ke_schvaleni').insert({
            obchod_trh_id: store.id,
            kod: cleanCode,
            popis: coupon.popis,
            sleva_hodnota: coupon.sleva_hodnota,
            podminky: coupon.podminky,
            platnost_od: coupon.platnost_od || null,
            platnost_do: coupon.platnost_do || null,
            pro_nove_zakazniky: coupon.pro_nove_zakazniky,
            zdroj_typ: 'automat_web',
            zdroj_info: coupon.zdroj_url || store.webova_adresa,
            ai_jistota: 90,
            stav: 'ceka',
            surova_data: coupon
          });
          console.log(`   ✅ Nový kupón uložen ke schválení: ${cleanCode} (${coupon.sleva_hodnota})`);
        } else {
          console.log(`   ℹ️ Kupón ${cleanCode} už v databázi existuje, přeskakuji.`);
        }

        if (coupon.platnost_do && (!latestExpiration || coupon.platnost_do > latestExpiration)) {
          latestExpiration = coupon.platnost_do;
        }
      }

      // F) Aktualizace stavu obchodu
      await supabase
        .from('obchody_trhy')
        .update({
          posledni_kontrola_webu: new Date().toISOString(),
          posledni_hash_obsahu: currentHash,
          preskocit_kontrolu_do: latestExpiration
        })
        .eq('id', store.id);

    } catch (err) {
      console.error(`❌ Chyba u obchodu ${store.obchod_slug}:`, err);
    } finally {
      await page.close();
    }
  }

  await browser.close();
  console.log('🎉 Kontrola všech obchodů dokončena!');
}

runScraper();
