// Local-only photo fixtures. No Supabase, no production bookings or real clients.
// bun run qa:photo --annotate  → 127.0.0.1:4177, upload photos and choose expected values.
// bun run qa:photo             → regression, capped at 40 vision calls per invocation.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  calculatePhotoPrice,
  validatePhotoConfig,
  type PhotoClassification,
} from "../../src/lib/photo-pricing";

const root = dirname(fileURLToPath(import.meta.url));
const catalogPath = join(root, "catalog.json");
const casesPath = join(root, "cases.json");
const images = join(root, "images");
const budgetPath = join(root, "..", "api-budget-local.json");
const PHOTO_BUDGET_USD = 2.99;
// Deliberately conservative reservation: the model is capped at 512 output tokens and medium
// image resolution. Do not refund on HTTP errors/timeouts; an ambiguous request may be billed.
const RESERVE_PER_PHOTO_USD = 0.05;
type Service = {
  id: string;
  name: string;
  price: number;
  price_max: number;
  photo_pricing_config: unknown;
};
type Case = { file: string; serviceId: string; expected: PhotoClassification };
const read = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8"));
const catalog = () => read<Service[]>(catalogPath);
const cases = () => read<Case[]>(casesPath);

if (process.argv.includes("--annotate")) {
  mkdirSync(images, { recursive: true });
  const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Qabyl — фотофикстуры</title>
<style>body{font:16px system-ui;max-width:680px;margin:30px auto;padding:0 16px}label{display:block;margin:16px 0}input,select,button{font:inherit;padding:8px}select{max-width:100%}button{cursor:pointer}#criteria label{display:flex;justify-content:space-between;gap:12px}p{color:#555}</style>
<h1>Разметка фото для тестов</h1><p>Всё локально на этом компьютере. Загрузите экспорт правил из кабинета, затем снимок и отметьте правильные признаки. Цена посчитается сама.</p>
<label>Экспорт правил из Qabyl <input id="catalog" type="file" accept="application/json"></label>
<label>Фото <input id="photo" type="file" accept="image/jpeg,image/png,image/webp"></label>
<label>Услуга <select id="service"></select></label>
<label><input id="relevant" type="checkbox" checked> Фото относится к этой услуге</label>
<div id="criteria"></div><p id="price"></p><button id="save">Сохранить ожидаемый результат</button><p id="status"></p>
<script>
let services=[];const $=id=>document.getElementById(id);
async function refresh(){services=await(await fetch('/catalog')).json();const sel=$('service');sel.replaceChildren();for(const s of services){const o=document.createElement('option');o.value=s.id;o.textContent=s.name;sel.append(o)}render()}
function render(){const s=services.find(x=>x.id===$('service').value);$('criteria').replaceChildren();for(const c of s?.photo_pricing_config?.criteria||[]){const l=document.createElement('label');l.textContent=c.label;const sel=document.createElement('select');sel.dataset.criterion=c.id;const unknown=document.createElement('option');unknown.value='';unknown.textContent='Не видно / не уверен';sel.append(unknown);for(const o of c.options){const v=document.createElement('option');v.value=o.id;v.textContent=o.label;sel.append(v)}sel.onchange=price;l.append(sel);$('criteria').append(l)}price()}
function expectation(){const s=services.find(x=>x.id===$('service').value);const relevant=$('relevant').checked;const values={};const uncertain=[];let amount=s?.price||0;for(const select of $('criteria').querySelectorAll('select')){const c=s.photo_pricing_config.criteria.find(x=>x.id===select.dataset.criterion);if(!select.value){uncertain.push(c.id);continue}values[c.id]=select.value;const o=c.options.find(x=>x.id===select.value);if(c.mode==='base')amount=o.amount;else amount+=o.amount}return {s,expected:{relevant,values,uncertain},amount}}
function price(){const x=expectation();$('price').textContent=!x.s?'Импортируйте правила':!x.expected.relevant?'Ожидается просьба прислать подходящее фото':x.expected.uncertain.length?'Ожидается уточнение: '+x.expected.uncertain.join(', '):'Ожидаемая цена: '+x.amount}
$('service').onchange=render;$('relevant').onchange=price;
$('catalog').onchange=async()=>{const f=$('catalog').files[0];if(!f)return;const r=await fetch('/catalog',{method:'POST',body:await f.text()});$('status').textContent=r.ok?'Правила загружены':await r.text();if(r.ok)refresh()};
$('save').onclick=async()=>{const f=$('photo').files[0],x=expectation();if(!f||!x.s){$('status').textContent='Выберите фото и услугу';return}const form=new FormData();form.set('photo',f);form.set('serviceId',x.s.id);form.set('expected',JSON.stringify(x.expected));const r=await fetch('/case',{method:'POST',body:form});$('status').textContent=r.ok?'Сохранено. Можно добавить следующее фото.':await r.text();if(r.ok)$('photo').value=''};
refresh();</script></html>`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 4177,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/")
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      if (req.method === "GET" && url.pathname === "/catalog") return Response.json(catalog());
      if (req.method === "POST" && url.pathname === "/catalog") {
        const body = await req.text();
        if (body.length > 200_000) return new Response("Слишком большой файл", { status: 400 });
        try {
          const rows = JSON.parse(body);
          if (
            !Array.isArray(rows) ||
            rows.length > 200 ||
            rows.some(
              (s) =>
                typeof s.id !== "string" ||
                typeof s.name !== "string" ||
                !Number.isFinite(s.price) ||
                !Number.isFinite(s.price_max) ||
                !validatePhotoConfig(s.photo_pricing_config),
            )
          )
            throw Error();
          writeFileSync(catalogPath, JSON.stringify(rows, null, 2));
          return new Response("ok");
        } catch {
          return new Response(
            "Неверный формат правил: экспортируйте их из Qabyl после сохранения",
            { status: 400 },
          );
        }
      }
      if (req.method === "POST" && url.pathname === "/case") {
        const form = await req.formData();
        const photo = form.get("photo");
        const serviceId = form.get("serviceId");
        if (
          !(photo instanceof File) ||
          photo.size > 5_000_000 ||
          !["image/jpeg", "image/png", "image/webp"].includes(photo.type) ||
          !catalog().some((s) => s.id === serviceId)
        )
          return new Response("Неверное фото/услуга (до 5 МБ, JPG/PNG/WebP)", { status: 400 });
        try {
          const expected = JSON.parse(String(form.get("expected")));
          if (
            typeof expected.relevant !== "boolean" ||
            !expected.values ||
            typeof expected.values !== "object" ||
            !Array.isArray(expected.uncertain)
          )
            throw Error();
          const bytes = new Uint8Array(await photo.arrayBuffer());
          const valid =
            photo.type === "image/jpeg"
              ? bytes[0] === 0xff && bytes[1] === 0xd8
              : photo.type === "image/png"
                ? bytes[0] === 0x89 && bytes[1] === 0x50
                : String.fromCharCode(...bytes.slice(0, 4)) === "RIFF";
          if (!valid) throw Error();
          const file = `${crypto.randomUUID()}${photo.type === "image/jpeg" ? ".jpg" : photo.type === "image/png" ? ".png" : ".webp"}`;
          writeFileSync(join(images, file), bytes);
          const all = cases();
          all.push({ file, serviceId: String(serviceId), expected });
          writeFileSync(casesPath, JSON.stringify(all, null, 2));
          return new Response("ok");
        } catch {
          return new Response("Неверная разметка/фото", { status: 400 });
        }
      }
      return new Response("Not found", { status: 404 });
    },
  });
  console.log(`Разметка: ${server.url}`);
} else {
  const all = cases();
  const maxCalls = 40; // A bounded run. Never automatically replay the entire corpus on a paid key.
  if (!all.length) {
    console.log("Фотофикстур пока нет: 0 проверок, API-вызовов 0. Добавьте фото через --annotate.");
    process.exit(0);
  }
  if (all.length > maxCalls) {
    console.error(`Задано ${all.length} фото, лимит одного прогона ${maxCalls}; запуск отменён.`);
    process.exit(2);
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error("GEMINI_API_KEY не задан. Платных вызовов 0.");
    process.exit(2);
  }
  const { classifyPhotoForPrice } = await import("../../src/lib/wa-agent.server");
  let correct = 0,
    compared = 0,
    prices = 0,
    priceCompared = 0,
    needsCorrect = 0;
  const byCriterion: Record<string, { correct: number; total: number }> = {};
  for (const c of all) {
    const s = catalog().find((v) => v.id === c.serviceId);
    const config = validatePhotoConfig(s?.photo_pricing_config);
    if (!s || !config || !/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(c.file)) {
      console.error(`Пропущен неверный fixture: ${c.file}`);
      continue;
    }
    const mime =
      extname(c.file) === ".png"
        ? "image/png"
        : extname(c.file) === ".webp"
          ? "image/webp"
          : "image/jpeg";
    const reserved = existsSync(budgetPath)
      ? Number(read<{ reservedUsd: number }>(budgetPath).reservedUsd)
      : 0;
    if (!Number.isFinite(reserved) || reserved + RESERVE_PER_PHOTO_USD > PHOTO_BUDGET_USD) {
      console.error(
        `Локальный бюджет исчерпан: зарезервировано $${reserved.toFixed(2)} из $${PHOTO_BUDGET_USD}. Следующие фото не отправлены.`,
      );
      break;
    }
    // Persist BEFORE the network call. Repeated CLI runs share one ledger and cannot silently
    // replay fixtures for free. Google account-wide use still needs an external spend cap.
    writeFileSync(
      budgetPath,
      JSON.stringify({ reservedUsd: Number((reserved + RESERVE_PER_PHOTO_USD).toFixed(2)) }),
    );
    const actual = await classifyPhotoForPrice({
      apiKey: key,
      imageBase64: readFileSync(join(images, c.file)).toString("base64"),
      mime,
      serviceName: s.name,
      config,
    });
    if ("error" in actual) {
      console.log(`${c.file}: ERROR ${actual.error}`);
      continue;
    }
    compared++;
    if (actual.relevant === c.expected.relevant) correct++;
    for (const criterion of config.criteria) {
      const score = (byCriterion[criterion.id] ??= { correct: 0, total: 0 });
      score.total++;
      const expected = c.expected.values[criterion.id] ?? null,
        got = actual.values[criterion.id] ?? null;
      if (
        got === expected &&
        !!actual.uncertain?.includes(criterion.id) ===
          !!c.expected.uncertain?.includes(criterion.id)
      )
        score.correct++;
    }
    const expectedPrice = calculatePhotoPrice(config, c.expected, s);
    const actualPrice = calculatePhotoPrice(config, actual, s);
    if ("price" in expectedPrice) {
      priceCompared++;
      if ("price" in actualPrice && actualPrice.price === expectedPrice.price) prices++;
    }
    if ("needs" in expectedPrice && "needs" in actualPrice) needsCorrect++;
    console.log(
      `${c.file}: ${JSON.stringify({ expected: c.expected, actual, expectedPrice, actualPrice })}`,
    );
  }
  console.log(
    JSON.stringify(
      {
        photos: all.length,
        compared,
        relevantAccuracy: `${correct}/${compared}`,
        criteria: byCriterion,
        pricingAccuracy: `${prices}/${priceCompared}`,
        uncertaintyCorrect: needsCorrect,
        localBudgetReservedUsd: existsSync(budgetPath)
          ? read<{ reservedUsd: number }>(budgetPath).reservedUsd
          : 0,
      },
      null,
      2,
    ),
  );
}
