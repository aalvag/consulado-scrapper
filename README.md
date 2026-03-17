# Consulado Scraper 🇪🇸

Bot automático que monitorea la disponibilidad de turnos en el **Consulado General de España en Buenos Aires**, con notificaciones vía Telegram.

## ¿Qué hace?

- Vigila los trámites configurados en `site_map.json` buscando slots disponibles
- Solo envía Telegram cuando hay turnos en el trámite de interés (por defecto: **Alta en matrícula consular**)
- Respeta el calendario de feriados argentinos — corre el **primer día hábil de la semana** a las 10:45-11:30 ARG (cuando abren los turnos)
- Envía un **heartbeat** periódico para confirmar que el bot está activo

## Setup local

```bash
npm install
npx playwright install chromium
cp .env.example .env
# Completar .env con tus tokens
node scraper.js
```

## Variables de entorno

| Variable | Descripción | Requerida |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Token del bot (BotFather) | Sí |
| `TELEGRAM_CHAT_ID` | ID del chat donde llegan las alertas | Sí |
| `MONITOR_ALL` | `true` = monitorear todos los trámites del `site_map.json` | No |
| `NOTIFY_TARGET_IDS` | IDs de trámites que disparan Telegram (default: `4`) | No |
| `HEADLESS` | `false` = ver el navegador (útil en local) | No |
| `MODE` | `discovery` = mapear el sitio y regenerar `site_map.json` | No |
| `INTENSIVE` | `true` = forzar ejecución ignorando el chequeo de feriados | No |

## GitHub Actions

El workflow corre automáticamente:
- **Cada hora** (modo ahorro)
- **Lun-Vie 10:45-11:30 ARG** (modo intensivo, con chequeo de feriados)

### Secrets requeridos en el repo

`Settings → Secrets and variables → Actions`

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

## Trámites disponibles

Generados por el modo discovery en `site_map.json`. Para regenerar:

```bash
MODE=discovery node scraper.js
```
