# Stromblick Deutschland

Live-Webapp fuer Stromerzeugung, Netzfrequenz und Strommarkt-Kennzahlen in Deutschland.

## Lokal starten

```bash
node server.js
```

Die App laeuft dann unter `http://localhost:4173`.

## Kleines Hosting mit Render

1. Projekt in ein GitHub-Repository legen.
2. Bei Render ein neues `Blueprint` oder `Web Service` aus diesem Repository erstellen.
3. Falls Render nicht automatisch `render.yaml` nutzt:
   - Runtime: `Node`
   - Start Command: `node server.js`
   - Environment Variable: `HOST=0.0.0.0`
4. Render setzt den Port automatisch ueber `PORT`.

Die App braucht keine Datenbank und keine Secrets.

## Datenquellen

- Fraunhofer ISE Energy-Charts API
- netzfrequenzmessung.de
