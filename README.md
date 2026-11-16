# MB Jack — Western Blackjack

2D prohlížečová hra Blackjack zasazená do westernového saloonu **MB Jack**. Napsaná čistě v **HTML, CSS a vanilla JavaScriptu** bez externích závislostí a build kroku — funguje jak přes lokální HTTP server, tak po přímém otevření `index.html` (`file://`).

---

## Pravidla (dle `rules.txt`)

Veškerá konfigurace pravidel je soustředěna v [`js/rules.js`](js/rules.js):

- **6 balíčků**, cut card na 75 %, automatické míchání před dalším kolem.
- **Hodnoty karet:** 2–10 nominální hodnota, J/Q/K za 10, Eso za 1 nebo 11 podle výhodnosti.
- **Výplaty:** Blackjack (Eso + 10/obrázek na první 2 karty) **3:2**, klasická výhra **1:1**, remíza (Push) vrací sázku.
- **Krupiér:** Tahá na 16 a méně, stojí na každých 17 až 21 (S17). Při esu nebo desítce kontroluje Blackjack (peek).
- **Možnosti hráče:**
  - **Líznout (Hit)** a **Stát (Stand)**
  - **Double Down** na první 2 karty (i po splitu)
  - **Split** párů stejné hodnoty (až 4 ruce na místo; rozdělená esa dostanou po 1 kartě, 21 po splitu není Blackjack)
  - **Pojištění (Insurance)** při esu krupiéra za ½ sázky (vyplácí 2:1)
  - **Vzdát se (Late Surrender)** z prvních 2 karet vrátí ½ sázky
- **Stůl:** 3 hráčská sázková místa, sázka $5–$500 na místo, startovní bankroll $1 000 (s možností doplnění při nule).

---

## Architektura

Projekt používá globální namespace `window.MBJ` a přísně odděluje synchronní herní stav od vizuální scény:

| Soubor | Odpovědnost |
| --- | --- |
| `js/rules.js` | Konfigurace všech pravidel Blackjacku (`MBJ.RULES`) |
| `js/shoe.js` | Karty a multi-deck zásobník (`MBJ.Shoe`) s cut card |
| `js/hand.js` | Čistá aritmetika ruky včetně měkkých součtů s esy (`MBJ.Hand`) |
| `js/blackjack.js` | Autoritativní stavový automat Blackjacku (`MBJ.BlackjackEngine`) bez závislosti na DOM |
| `js/events.js` | Synchronní event bus (`MBJ.EventBus`) |
| `js/animator.js` | RAF tween systém pro animace karet a žetonů (`MBJ.Animator`) |
| `js/audio.js` | Volitelné syntetizované zvukové efekty přes Web Audio API (`MBJ.SoundEffects`) |
| `js/sprites.js` | SVG vektorové karty (včetně figur J/Q/K a rubu) a perspektivní stohy žetonů |
| `js/scene.js` | Vizuální choreografie a fronta animací na plátně 1376 × 768 (`MBJ.TableScene`) |
| `js/ui.js` | Interakce na stole, stojánek žetonů, sázková místa, klávesové zkratky (`MBJ.TableUI`) |
| `js/app.js` | Propojení enginu, scény, UI a zvuku (`window.MBJack`) |
| `tests/engine.test.mjs` | Jednotkové testy pravidel + 20 000 náhodných her v Node.js |

---

## Ovládání

- **Sázení:** Klikni na žeton ve stojánku (nebo klávesy `1–4`) a potom na jeden ze 3 zlatých kruhů na stole. Pravý klik nebo `×` u kruhu sázku odebere.
- **Rozdání / Líznutí:** Klikni na dřevěný zásobník karet vpravo na stole (nebo tlačítko **Rozdat** / **Líznout**).
- **Klávesové zkratky:** `Mezerník`/`Enter` rozdat nebo nové kolo · `H` líznout · `S` stát · `D` double · `P` split · `R` vzdát se · `Y`/`N` pojištění.

---

## Testy

```bash
node tests/engine.test.mjs
```
