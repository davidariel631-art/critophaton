# Backtest histórico de TheHaton — usando el motor real

Esto corre el mismo motor de producción (`thehaton-engine.js`) contra datos históricos
REALES de BTC, para medir si la lógica central (estructura SMC + comité de Dioses +
Estocástico/MACD + gestión de TP/SL) tiene alguna ventaja real usando solo precio y volumen.

## Qué hay en esta carpeta

- `thehaton-engine.js` — copia del motor de producción (mismo archivo que usa la web y el bot)
- `run_backtest.mjs` — simula el ciclo completo: detecta en 4h → confirma en 15m → gestiona TP1/TP2/stop
- `analyze_results.mjs` — calcula win rate, profit factor, drawdown, y compara contra "comprar y mantener"
- `data/` — velas de BTC ya resampleadas a 4h y 15m, para tres períodos ya probados:
  - `btc_4h_2023-2025.json` / `btc_15m_2023-2025.json` — mercado alcista fuerte (2023-01-01 a 2025-01-07)
  - `btc_4h_2022.json` / `btc_15m_2022.json` — mercado bajista fuerte (2022, BTC cayó -64%)
  - `btc_4h_2019-lateral.json` / `btc_15m_2019-lateral.json` — mercado lateral (enero-marzo 2019)

## Cómo correrlo

```bash
node run_backtest.mjs data/btc_4h_2022.json data/btc_15m_2022.json resultado_2022.json
node analyze_results.mjs resultado_2022.json data/btc_4h_2022.json
```

## Cómo conseguir más datos para probar otros períodos

Los datos de este backtest salen de un dataset público y gratis en GitHub (BTC/USD de
Bitstamp, minuto a minuto, desde 2012):

https://github.com/ff137/bitstamp-btcusd-minute-data

1. Bajar el archivo `data/historical/btcusd_bitstamp_1min_2012-2025.csv.gz` de ese repo
2. Descomprimirlo (`gunzip`)
3. Resamplear a 4h y 15m con pandas (agrupando por ventanas de tiempo, tomando primer/máximo/mínimo/
   último/suma de cada ventana para open/high/low/close/volume respectivamente)
4. Guardar como JSON con el formato `{t, o, h, l, c, v}` (mismo formato que usa el motor)

## Resultados ya obtenidos (referencia)

**Con comisiones y deslizamiento simulados (0.1% de fricción por cada "pata" de la operación —
entrada, salida parcial en TP1, salida final — un estimado conservador de futuros en Binance):**

| Período | Bot (con comisiones) | Comprar y mantener | ¿Bot ganó? | Muestra |
|---|---|---|---|---|
| 2023-2025 (alcista fuerte, BTC +519%) | **-6.7%** (drawdown 21.4%) | +519.5% | NO | 101 operaciones |
| 2022 (bajista fuerte, BTC -64%) | **-2.4%** (drawdown 6.0%) | -64.2% | NO* | 31 operaciones |
| Ene-Mar 2019 (lateral, BTC +11%) | +17.7% (drawdown 1.1%) | +11.4% | SÍ | Solo 11 operaciones — muestra demasiado chica para confiar |

*En 2022 el bot pierde menos que el mercado (-2.4% vs -64.2%), pero ya no está en positivo como
antes de sumar comisiones.

**⚠️ Hallazgo más importante de todo este backtest**: sin comisiones, el bot se veía positivo en
2 de los 3 períodos. Con comisiones y deslizamiento REALISTAS aplicadas, **se da vuelta a
pérdida en 2 de los 3 períodos** (2023-2025 y 2022). Esto confirma exactamente lo que advertía
la investigación previa: una ventaja marginal (win rate cerca del 50%, profit factor apenas
arriba de 1) puede desaparecer por completo — o volverse negativa — apenas se suman los costos
reales de operar. El único período que se mantiene positivo (2019 lateral) tiene una muestra
demasiado chica (11 operaciones) para confiar en el resultado todavía.

<details>
<summary>Resultados SIN comisiones (para referencia/comparación)</summary>

| Período | Bot | Comprar y mantener | ¿Bot ganó? |
|---|---|---|---|
| 2023-2025 | +19.1% (drawdown 12.4%) | +519.5% (drawdown 30.1%) | NO |
| 2022 | +3.1% (drawdown 4.9%) | -64.2% (drawdown 67.4%) | SÍ |
| Ene-Mar 2019 | +20.1% (drawdown 1.0%) | +11.4% (drawdown 17.3%) | SÍ |

</details>

## Limitaciones honestas (léelas antes de sacar conclusiones)

- **Sin funding, sin Open Interest, sin Fear&Greed, sin FOMC histórico aplicado retroactivamente**
  — esos filtros del bot real no están simulados acá (no hay ese dato histórico gratis para 2022-2025)
- **Solo BTC** — no se probó con altcoins, que es la mayoría de lo que opera el bot en producción
- **Sin comisiones ni slippage** — el resultado real en vivo sería algo peor
- **Muestra chica** (31-101 operaciones por período) — todavía por debajo del mínimo de 100-400+
  operaciones para tener confianza estadística real
- Esto mide si la **lógica central** tiene ventaja usando solo precio/volumen — no reemplaza medir
  el bot completo en vivo con todos sus filtros reales

## Próximos pasos posibles

- Probar más períodos laterales (uno de 11 operaciones no alcanza — hace falta varios más para confiar)
- Probar con alguna altcoin líquida (ETH, por ejemplo) para no depender solo de BTC
- Walk-forward: optimizar parámetros en un período, validar en el siguiente sin tocar nada
- Ajustar el % de fricción simulada si tenés datos reales de cuánto paga tu cuenta en comisiones/slippage
