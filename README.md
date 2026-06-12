# Advokatappen

Timeføring og fakturering for norske advokater, så enkelt som overhodet mulig. Bygget etter idémøtet mellom Axel og Julie 12. juni 2026 (full bakgrunn i Obsidian: 🎯 Prosjekter/Advokatappen).

## Hva den gjør

- Klientoversikt: alle klientene dine når du åpner appen
- Ny klient registreres med fem raske spørsmål (navn, fødselsdato, sivil/straff, privat/offentlig salær, timesats) som plasserer klienten i riktig faktureringskategori
- Tidtaking med ett trykk: velg aktivitet ("Klient ringer", "Klientmøte" osv.), trykk start, trykk stopp. Tiden registreres direkte på klienten
- Privat klient: tid avregnes per påbegynt kvarter, slik bransjepraksis er. Målt råtid vises også
- Offentlig salær: salæroppgaven følger salærforskriften § 5, samlet tid utenom rettsmøter avrundes opp til nærmeste halvtime, rettsmøter avrundes per dag og godtgjøres med minst én time
- Faktura med ett trykk: spesifisert per føring (dato, aktivitet, timer, sats), med mva-linje, klar til utskrift eller PDF
- Private klienter: månedsfaktura ligger klar når en ny måned starter
- Offentlig salær: appen varsler når oppdraget passerer 60 timer ("naturlig å avregne") og lager salæroppgave til domstolen
- Innstillinger for advokatens fakturaopplysninger

## Hva den bevisst ikke gjør (ennå)

Ingen AI, ingen innlogging, ingen sky, ingen integrasjoner. Alt lagres lokalt i nettleseren (localStorage). Se "Fremtidige ideer" i Obsidian-prosjektet.

## Kjøre den

Åpne `index.html` i en nettleser, ferdig. For å bruke den som app på telefonen (PWA, "Legg til på Hjem-skjerm") må den serveres over http:

```bash
cd advokatappen
python3 -m http.server 8420
# åpne http://localhost:8420
```

Ren HTML, CSS og JavaScript. Ingen avhengigheter, ingen byggsteg.

## Teknisk

- `index.html`: skall og fonter
- `styles.css`: hele designet (papir, blekk, flaskegrønn, messing; Fraunces, Schibsted Grotesk og Courier Prime)
- `app.js`: tilstand, visninger, tidtaker, fakturagenerering. Data i `localStorage` under nøkkelen `advokatappen.v1`
- Utskrift: fakturaen rendres til `#print-root`, og print-CSS skjuler resten av appen
