import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI, Type, Schema } from '@google/genai';
import { chromium, Page } from 'playwright';
import crypto from 'crypto';
import 'dotenv/config';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

const couponResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    found_coupons: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          kod: { type: Type.STRING, description: 'Slevový kód (velkými písmeny, bez mezer)' },
          nadpis: { type: Type.STRING, description: 'Krátký výstižný nadpis v jazyce trhu, např. "Sleva 20 % na vše"' },
          sleva_typ: {
            type: Type.STRING,
            enum: [
              'procento', 'CZK', 'EUR', 'USD', 'PLN', 'GBP', 'HUF',
              'doprava_zdarma', 'darek', 'akce_1plus1', 'jina_akce'
            ]
          },
          sleva_hodnota: {
            type: Type.NUMBER,
            nullable: true,
            description: 'Číselná hodnota slevy (pouze pro procento nebo měny). Pro doprava_zdarma, darek, akce_1plus1 a jina_akce MUSÍ být null!'
          },
          popis: {
            type: Type.STRING,
            description: 'Shrnuté podmínky kupónu (minimální objednávka, na co platí, výjimky).'
          },
          podminky_surove: {
            type: Type.STRING,
            nullable: true,
            description: 'Doslovný přepis podmínek z webu nebo ze skrytého kódu.'
          },
          plati_od: { type: Type.STRING, nullable: true, description: 'Datum začátku YYYY-MM-DD, pokud je v textu nebo v kódu' },
          plati_do: { type: Type.STRING, nullable: true, description: 'Datum konce platnosti YYYY-MM-DD (včetně dat nalezených v JSON/HTML kódu)' },
          nalezeno_na_url: { type: Type.STRING, nullable: true, description: 'Konkrétní URL adresa ze vstupu, kde byl kupón nalezen' }
        },
        required: ['kod', 'nadpis', 'sleva_typ', 'popis']
      }
    }
  },
  required: ['found_coupons']
};

async function deepExtractStoreData(page: Page, mainUrl: string, extraUrls: string[] = []): Promise<string> {
  const urlsToVisit = new Set<string>([mainUrl, ...(extraUrls || [])]);

  async function extractSinglePage(url: string, findSubpages: boolean): Promise<string> {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3500);

      const extracted = await page.evaluate((shouldFindLinks: boolean) => {
        const discoveredLinks: string[] = [];
        if (shouldFindLinks) {
          const keywords = /kupon|kupón|slev|akce|akčn|vyprodej|výprodej|voucher|promo|rabat|gutschein|podminky|kod|kód/i;
          document.querySelectorAll('a[href]').forEach((a) => {
            const href = (a as HTMLAnchorElement).href;
            const text = a.textContent || '';
            if (
              href.startsWith(window.location.origin) &&
              !href.includes('#') &&
              (keywords.test(href) || keywords.test(text))
            ) {
              discoveredLinks.push(href);
            }
          });
        }

        const hiddenScriptsData: string[] = [];
        document.querySelectorAll('script[type="application/ld+json"], script#__NEXT_DATA__, script#__NUXT_DATA__').forEach((s) => {
          if (s.textContent) hiddenScriptsData.push(s.textContent.slice(0, 4000));
        });

        document.querySelectorAll('script:not([src])').forEach((s) => {
          const content = s.textContent || '';
          if (/coupon|kupon|promo|valid|expire|countdown|sleva|voucher/i.test(content)) {
            hiddenScriptsData.push(content.slice(0, 2500));
          }
        });

        const dataAttributes: string[] = [];
        document.querySelectorAll('[data-code], [data-coupon], [data-countdown], [data-end], [data-valid], [data-expire], [title]').forEach((el) => {
          const attrs = Array.from(el.attributes)
            .filter(attr => attr.name.startsWith('data-') || attr.name === 'title')
            .map(attr => `${attr.name}="${attr.value}"`)
            .join(' ');
          if (attrs) dataAttributes.push(attrs);
        });

        document.querySelectorAll('script, style, svg, noscript, iframe').forEach(el => el.remove());
        const fullTextIncludingHidden = document.body.textContent?.replace(/\s+/g, ' ').trim() || '';

        return {
          discoveredLinks: Array.from(new Set(discoveredLinks)).slice(0, 2),
          combinedText: [
            `[TEXT A SKRYTÉ PODMÍNKY]: ${fullTextIncludingHidden.slice(0, 14000)}`,
            dataAttributes.length ? `[HTML ATRIBUTY A ODPOČTY]: ${dataAttributes.join(' | ').slice(0, 2500)}` : '',
            hiddenScriptsData.length ? `[DATA V KÓDU STRÁNKY]: ${hiddenScriptsData.join('\n').slice(0, 4000)}` : ''
          ].filter(Boolean).join('\n')
        };
      }, findSubpages);

      for (const link of extracted.discoveredLinks) {
        urlsToVisit.add(link);
      }

      return `=== ZDROJ URL: ${url} ===\n${extracted.combinedText}`;
    } catch (e) {
      console.warn(`   ⚠️ Nepodařilo se načíst URL ${url}`);
      return '';
    }
  }

  const results: string[] = [];
  results.push(await extractSinglePage(mainUrl, true));

  for (const subUrl of Array.from(urlsToVisit)) {
    if (subUrl !== mainUrl) {
      console.log(`   ↳ Procházím podstránku: ${subUrl}`);
      const subContent = await extractSinglePage(subUrl, false);
      if (subContent) results.push(subContent);
    }
  }

  return results.join('\n\n');
}

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
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  for (const store of stores) {
    console.log(`\n🔍 Kontroluji: ${store.obchod_id} (${store.kod_zeme}) -> ${store.webova_adresa}`);

    // KONTROLA VOLITELNÉ PAUZY (řízená čistě datem preskocit_kontrolu_do)
    if (store.pauza_pri_aktivnim_kuponu && store.preskocit_kontrolu_do && store.preskocit_kontrolu_do >= today) {
      console.log(`⏸️ Přeskakuji (pauza po webovém kupónu nastavena do ${store.preskocit_kontrolu_do})`);
      continue;
    }

    try {
      const fullStoreContent = await deepExtractStoreData(
        page,
        store.webova_adresa,
        store.dalsi_url_ke_kontrole || []
      );

      if (!fullStoreContent.trim()) continue;

      const currentHash = crypto.createHash('md5').update(fullStoreContent).digest('hex');

      if (store.posledni_hash_obsahu === currentHash) {
        console.log('⏭️ Obsah webu ani podstránek se od včerejška nezměnil, přeskakuji AI.');
        await supabase
          .from('obchody_trhy')
          .update({ posledni_kontrola_at: new Date().toISOString() })
          .match({ obchod_id: store.obchod_id, kod_zeme: store.kod_zeme });
        continue;
      }

      const prompt = `
        Dnešní datum je ${today}. Analyzuj vyextrahovaná data z e-shopu "${store.lokalni_nazev || store.obchod_id}" (země: ${store.kod_zeme}, výchozí měna: ${store.mena}).
        Vstup obsahuje viditelný text, skryté modaly s podmínkami, HTML atributy odpočtů i JSON data ze zdrojového kódu hlavní stránky a podstránek.
        
        Úkol:
        1. Najdi všechny slevové kódy (kupóny), které zákazník může zadat v košíku. Ignoruj slevy, které žádný kód nevyžadují.
        2. Z textu i ze skrytých dat v kódu vyčti datum platnosti (plati_od, plati_do) a převeď ho na YYYY-MM-DD. Pokud je platnost již v minulosti (před ${today}), kupón vůbec nevracej!
        3. Pečlivě dohledej všechny podmínky kupónu (minimální hodnota objednávky, omezení na značky/kategorie, poznámky pod hvězdičkou *) a přehledně je napiš do pole "popis".
        4. Pokud je sleva v penězích, použij jako sleva_typ měnu "${store.mena}". Pokud jde o dopravu zdarma, dárek, 1+1 nebo jinou akci bez konkrétní částky, nastav sleva_hodnota na null.

        Data z e-shopu:
        ${fullStoreContent.slice(0, 35000)}
      `;

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: couponResponseSchema,
          temperature: 0.1
        }
      });

      const parsed = JSON.parse(response.text || '{"found_coupons": []}');

      for (const item of parsed.found_coupons) {
        const cleanCode = item.kod.trim().toUpperCase();

        const { data: existingInProd } = await supabase
          .from('kupony')
          .select('id')
          .eq('obchod_id', store.obchod_id)
          .eq('kod_zeme', store.kod_zeme)
          .ilike('kod', cleanCode)
          .limit(1);

        if (existingInProd && existingInProd.length > 0) {
          console.log(`   ℹ️ Kód ${cleanCode} už v ostré tabulce kupony existuje.`);
          continue;
        }

        const isNumericDiscount = ['procento', 'CZK', 'EUR', 'USD', 'PLN', 'GBP', 'HUF'].includes(item.sleva_typ);

        const { data: inserted, error: insertError } = await supabase
          .from('kupony_ke_schvaleni')
          .upsert({
            obchod_id: store.obchod_id,
            kod_zeme: store.kod_zeme,
            kod: cleanCode,
            nadpis: item.nadpis,
            sleva_typ: item.sleva_typ,
            sleva_hodnota: isNumericDiscount && item.sleva_hodnota && item.sleva_hodnota > 0
              ? item.sleva_hodnota
              : null,
            popis: item.popis,
            podminky_surove: item.podminky_surove,
            plati_od: item.plati_od || today,
            plati_do: item.plati_do || null,
            cilova_url: item.nalezeno_na_url || store.webova_adresa,
            zdroj_typ: 'automat_web',
            stav: 'ceka'
          }, { onConflict: 'obchod_id,kod_zeme,kod', ignoreDuplicates: true })
          .select();

        if (!insertError && inserted && inserted.length > 0) {
          console.log(`   ✅ ULOŽEN NOVÝ KUPÓN KE SCHVÁLENÍ: ${cleanCode} (${item.nadpis})`);
        }
      }

      await supabase
        .from('obchody_trhy')
        .update({
          posledni_hash_obsahu: currentHash,
          posledni_kontrola_at: new Date().toISOString()
        })
        .match({ obchod_id: store.obchod_id, kod_zeme: store.kod_zeme });

      await page.waitForTimeout(5000);

    } catch (err) {
      console.error(`❌ Chyba u obchodu ${store.obchod_id}:`, err);
    }
  }

  await browser.close();
  console.log('\n🎉 Kontrola všech obchodů dokončena!');
}

runScraper();
