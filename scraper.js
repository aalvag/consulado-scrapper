require('dotenv').config(); // Carga .env en local (en GitHub Actions los Secrets se inyectan como env vars)

const { chromium } = require('playwright-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealthPlugin);

const fs = require('fs');
const path = require('path');
const notifier = require('node-notifier');

// ==========================================
// CONFIGURACIÓN Y SELECTORES CSS
// ==========================================
// URL objetivo PRINCIPAL: Alta en matrícula consular (?t=4)
const INITIAL_TARGET_URL = 'https://www.cgeonline.com.ar/tramites/citas/varios/cita-varios.html?t=4';


const SELECTOR_NO_APPOINTMENTS = '.alert.alert-danger'; 
const SELECTOR_AVAILABLE_SLOT = '.alert-success, button.btn-success, #btn-turno, select#citaSeleccionada option:not([value=""])'; 

const SELECTOR_CLOUDFLARE_BLOCK = '#cf-error-details';

// Mapeo de sitios (Discovery Mode)
// Actualizado: esta página contiene el menú principal de trámites
const DISCOVERY_ROOT = 'https://www.cgeonline.com.ar/tramites/opciones.html';
const LINKS_SELECTOR = 'a[href*=".html"]';

// Archivo para persistencia de cookies y mapa del sitio
const STORAGE_STATE_PATH = path.join(__dirname, 'storageState.json');
const SITE_MAP_PATH = path.join(__dirname, 'site_map.json');

// Configuración de Polleo
const POLL_INTERVAL_MS = 5000;
const MAX_RUN_TIME_MS = 14 * 60 * 1000;
const HEARTBEAT_EVERY_N = 60; // Mandar señal de vida cada ~60 intentos (5 min aprox)

// Zona horaria Argentina (UTC-3, sin DST)
const ARG_OFFSET_MS = -3 * 60 * 60 * 1000;

// ==========================================
// VERIFICACIÓN FERIADOS ARGENTINA
// ==========================================

/**
 * Obtiene la fecha actual en Argentina (ART = UTC-3).
 * No usa librerías externas, solo aritmética UTC.
 */
const getArgentinaDate = () => {
  const nowUTC = new Date();
  // Sumamos el offset de Argentina
  const nowARG = new Date(nowUTC.getTime() + ARG_OFFSET_MS);
  return {
    fullDate: nowARG,
    year: nowARG.getUTCFullYear(),
    month: nowARG.getUTCMonth() + 1,   // 1-12
    day: nowARG.getUTCDate(),
    dayOfWeek: nowARG.getUTCDay(),       // 0=Dom, 1=Lun, ..., 5=Vie, 6=Sab
  };
};

/**
 * Consulta los feriados de Argentina del año actual
 * usando la API pública: https://nolaborables.com.ar
 * Devuelve un Set de strings 'YYYY-MM-DD'.
 */
const fetchArgHolidays = async (year) => {
  const url = `https://nolaborables.com.ar/api/v2/feriados/${year}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    return new Set(
      data.map(h => {
        const d = String(h.dia).padStart(2, '0');
        const m = String(h.mes).padStart(2, '0');
        return `${year}-${m}-${d}`;
      })
    );
  } catch (err) {
    console.warn('⚠️ No se pudo obtener feriados. Asumimos que hoy no es feriado:', err.message);
    return new Set();
  }
};

/**
 * Verifica si HOY es el primer día hábil de la semana en Argentina.
 * - Si lunes no es feriado → el primer día hábil es el lunes (solo corre lunes).
 * - Si lunes ES feriado → el primer día hábil es el martes (corre martes).
 * - Y así sucesivamente hasta el viernes.
 * Si hoy NO es el primer día hábil → devuelve false (el script sale sin hacer nada).
 */
const checkIsFirstBusinessDay = async () => {
  const today = getArgentinaDate();
  const { year, month, day, dayOfWeek } = today;

  // Fines de semana nunca son días hábiles
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    console.log('📅 Hoy es fin de semana. Modo intensivo no aplica.');
    return false;
  }

  const todayStr = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  const holidays = await fetchArgHolidays(year);

  // Si hoy mismo es feriado, tampoco aplica
  if (holidays.has(todayStr)) {
    console.log(`📅 Hoy (${todayStr}) es feriado en Argentina. Modo intensivo no aplica.`);
    return false;
  }

  // Buscamos el primer día hábil de la semana actual
  // Retrocedemos desde el día de hoy hacia el lunes para ver si había algún día hábil antes
  for (let d = dayOfWeek - 1; d >= 1; d--) {
    const prevDate = new Date(today.fullDate.getTime());
    prevDate.setUTCDate(today.fullDate.getUTCDate() - (dayOfWeek - d));
    const prevStr = [
      prevDate.getUTCFullYear(),
      String(prevDate.getUTCMonth() + 1).padStart(2, '0'),
      String(prevDate.getUTCDate()).padStart(2, '0')
    ].join('-');

    if (!holidays.has(prevStr)) {
      // Había un día hábil antes de hoy esta semana → hoy NO es el primero
      console.log(`📅 El primer día hábil de esta semana fue ${prevStr}. Hoy (${todayStr}) no aplica para modo intensivo.`);
      return false;
    }
  }

  // Si llegamos acá, hoy es el primer día hábil de la semana ✅
  console.log(`✅ Hoy (${todayStr}) es el primer día hábil de la semana. ¡Modo intensivo ACTIVADO!`);
  return true;
};

// Trámites que disparan notificación Telegram (separados por coma en env, o por defecto solo ?t=4)
// Ponemos t=4 (Matrícula Consular) como destino principal de alertas
const NOTIFY_TARGET_IDS = (process.env.NOTIFY_TARGET_IDS || '4').split(',').map(s => s.trim());
const shouldNotify = (url) => NOTIFY_TARGET_IDS.some(id => url.endsWith(`?t=${id}`));

// Lista de URLs a monitorear
let TARGET_URLS = [INITIAL_TARGET_URL];
let URL_NAME_MAP = { [INITIAL_TARGET_URL]: 'Alta en matrícula consular' };

const loadTargetsFromMap = () => {
  if (fs.existsSync(SITE_MAP_PATH)) {
    try {
      const links = JSON.parse(fs.readFileSync(SITE_MAP_PATH, 'utf8'));
      const targetIds = process.env.TARGET_IDS ? process.env.TARGET_IDS.split(',') : null;
      
      if (process.env.MONITOR_ALL === 'true') {
        TARGET_URLS = links.map(l => l.href);
        links.forEach(l => { URL_NAME_MAP[l.href] = l.text; });
        console.log(`📈 Monitoreando TODOS los trámites (${TARGET_URLS.length})`);
      } else if (targetIds) {
        TARGET_URLS = links
          .filter(l => targetIds.includes(l.href.split('=').pop()))
          .map(l => l.href);
        links.forEach(l => { URL_NAME_MAP[l.href] = l.text; });
        console.log(`🎯 Monitoreando IDs seleccionados: ${targetIds.join(', ')}`);
      }
    } catch (e) {
      console.error('Error al cargar site_map.json:', e.message);
    }
  }
};

const randomDelay = (min = 1000, max = 2000) => {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
};

const sendLocalNotification = (title, message) => {
  notifier.notify({
    title: title,
    message: message,
    sound: true,
    wait: true
  });
};

const sendTelegramNotification = async (message) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
    });
  } catch (error) {
    console.error('Error Telegram:', error.message);
  }
};

const dumpPageContent = async (page, name) => {
  try {
    const content = await page.content();
    fs.writeFileSync(`${name}.html`, content);
    await page.screenshot({ path: `${name}.png`, fullPage: true, timeout: 8000 });
    console.log(`📸 Evidencia: ${name}.html / .png`);
  } catch (err) {
    console.error('Error dump:', err.message);
  }
};

// ==========================================
// MODO DISCOVERY (MAPEO)
// ==========================================
const runDiscovery = async (page) => {
  console.log(`🔍 Navegando a la central de trámites: ${DISCOVERY_ROOT}`);
  await page.goto(DISCOVERY_ROOT, { waitUntil: 'domcontentloaded' });
  
  // Extraer todos los enlaces de trámites posibles (que contengan ?t=)
  const links = await page.evaluate((selector) => {
    return Array.from(document.querySelectorAll(selector))
      .map(a => ({
        text: a.innerText.replace(/\n/g, ' ').trim(),
        href: a.href
      }))
      .filter(l => l.href.includes('?t=') && !l.href.includes('cancelar'));
  }, LINKS_SELECTOR);

  if (links.length > 0) {
    console.log(`🗺️ ¡Éxito! Descubiertos ${links.length} trámites activos.`);
    fs.writeFileSync(SITE_MAP_PATH, JSON.stringify(links, null, 2));
    console.log(`📁 Mapa guardado en: ${SITE_MAP_PATH}`);
  } else {
    console.log('⚠️ No se encontraron enlaces con el patrón "?t=". Quizás la estructura cambió.');
  }
  
  // Actualizar la lista de URLs para el monitoreo si el usuario quiere "todo"
  if (process.env.MONITOR_ALL === 'true' && links.length > 0) {
     TARGET_URLS = links.map(l => l.href);
     console.log('📈 Modo MONITOR_ALL activado. Se vigilarán todos los enlaces descubiertos.');
  }

  return links;
};

// ==========================================
// LÓGICA CORE (SCRAPER ENTERPRISE)
// ==========================================
(async () => {
  const isHeadless = process.env.HEADLESS !== 'false';
  const isDiscoveryMode = process.env.MODE === 'discovery';
  const isIntensiveMode = process.env.INTENSIVE === 'true'; // Forzado manual
  const startTime = Date.now();

  // --- GUARDIA DE FERIADOS ---
  // Si estamos en GitHub Actions (headless) y NO es modo forzado ni discovery,
  // verificamos que hoy sea el primer día hábil de la semana en Argentina.
  if (isHeadless && !isDiscoveryMode && !isIntensiveMode) {
    const shouldRun = await checkIsFirstBusinessDay();
    if (!shouldRun) {
      console.log('🚫 El modo intensivo no aplica hoy. Saliendo.');
      process.exit(0);
    }
  }

  const browser = await chromium.launch({
    headless: isHeadless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });

  const contextOptions = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires'
  };

  if (fs.existsSync(STORAGE_STATE_PATH)) {
    contextOptions.storageState = STORAGE_STATE_PATH;
  }

  const context = await browser.newContext(contextOptions);
  let page = await context.newPage();

  try {
    // Si estamos en modo descubrimiento, primero mapeamos
    if (isDiscoveryMode) {
      await runDiscovery(page);
    }
    
    // Cargamos los trámites desde el mapa (ya sea si acabamos de discovery o si ya existía)
    loadTargetsFromMap();

    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
      console.warn('⚠️  TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID no configurados. Las notificaciones Telegram están DESACTIVADAS.');
    } else {
      await sendTelegramNotification(`🚀 <b>Bot iniciado</b>\n📋 Monitoreando <b>${TARGET_URLS.length}</b> trámite(s)\n✅ Notificaciones Telegram activas.`);
      console.log('✅ Telegram configurado. Notificaciones activas.');
    }

    let attempt = 1;
    const notifiedUrls = new Set(); // Evita spam: solo notifica 1 vez por trámite por run
    while (true) {
      if (Date.now() - startTime > MAX_RUN_TIME_MS) {
        console.log('⏳ Tiempo Vencido. Reiniciando bucle de 15m.');
        break;
      }

      // Mezclar los trámites para evitar patrones fijos de navegación
      const shuffledTargets = [...TARGET_URLS].sort(() => Math.random() - 0.5);

      for (const targetUrl of shuffledTargets) {
        const procName = URL_NAME_MAP[targetUrl] || `Trámite ID: ${targetUrl.split('=').pop()}`;
        console.log(`\n--- Intento #${attempt} | ${procName} ---`);
        
        try {
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await randomDelay(2000, 4000); // Retardo humano entre trámites

          // 2. DETECCIÓN DE TURNOS (Prioridad Máxima)
          const availableSlots = await page.locator(SELECTOR_AVAILABLE_SLOT).count();
          const noAppointments = await page.locator(SELECTOR_NO_APPOINTMENTS).count();

          if (availableSlots > 0) {
            if (notifiedUrls.has(targetUrl)) {
              // Ya notificamos este trámite hoy, solo loguear
              console.log(`📍 Ya notificado: ${procName}. Slot sigue disponible.`);
            } else {
              console.log(`🎯 ¡CITA ENCONTRADA EN ${procName.toUpperCase()}!`);
              notifiedUrls.add(targetUrl);
              // Solo enviar Telegram y capturar si este trámite está en la lista de interés
              if (shouldNotify(targetUrl)) {
                const msg = `✅ <b>¡HAY TURNOS!</b>\n\n📌 <b>${procName}</b>\n\n🔗 <a href="${targetUrl}">Link Directo</a>`;
                await sendTelegramNotification(msg);
                sendLocalNotification('¡HAY TURNOS!', `Disponibilidad en: ${procName}`);
                await dumpPageContent(page, `success-${targetUrl.split('=').pop()}`);
              } else {
                console.log(`ℹ️ Slot en ${procName} detectado (no es tu trámite principal, sin Telegram).`);
              }
            }
            continue;
          }

          // 3. DETECCIÓN DE BLOQUEOS REALES (Solo si no hay turnos ni mensaje de "Sin turnos")
          const isCfBlocked = await page.locator(SELECTOR_CLOUDFLARE_BLOCK).count() > 0;
          if (isCfBlocked && noAppointments === 0 && availableSlots === 0) {
             console.error('🛑 BLOQUEO CLOUDFLARE DETECTADO.');
             await dumpPageContent(page, 'error-waf');
             continue; 
          }

          if (noAppointments > 0) {
            console.log(`Sin turnos para ${procName}.`);
          } else {
            console.log(`❔ Estado incierto para ${procName}.`);
          }

        } catch (err) {
          console.log(`⚠️ Error en ${procName}:`, err.message);
        }
      }

      console.log(`Dormimos ${POLL_INTERVAL_MS/1000}s...`);
      await page.waitForTimeout(POLL_INTERVAL_MS);

      // Heartbeat: señal de vida cada N intentos
      if (attempt % HEARTBEAT_EVERY_N === 0) {
        const { year, month, day, fullDate } = getArgentinaDate();
        const timeStr = fullDate.toUTCString().replace('GMT', 'ART');
        const msg = `🤖 <b>Bot activo</b> | Intento #${attempt}\n📋 Monitoreando <b>${TARGET_URLS.length}</b> trámite(s)\n🕐 ${timeStr}\n↩️ Sin turnos disponibles aún.`;
        await sendTelegramNotification(msg);
        console.log(`💓 Heartbeat enviado (intento #${attempt})`);
      }

      attempt++;
    }

  } catch (error) {
    console.error('Error Crítico:', error);
  } finally {
    await browser.close();
  }
})();
