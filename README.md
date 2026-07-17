# Chatwoot ↔ Microsoft Teams Bridge

Bridge-Service, der Nachrichten zwischen Microsoft Teams und Chatwoot verbindet. Teams-Nachrichten werden als eingehende Chatwoot-Conversations angelegt; Antworten von Agenten in Chatwoot werden per Webhook zurück an Teams gesendet.

## Architektur

```
Teams User  →  /api/messages       →  Chatwoot API (incoming)
Chatwoot Agent  →  /api/chatwoot/webhook  →  Teams (proactive reply)
```

## Einrichtung in Chatwoot

### 1. API-Kanal anlegen

1. In Chatwoot: **Einstellungen → Posteingänge → Posteingang hinzufügen → API**
2. Kanal benennen (z. B. „Microsoft Teams“)
3. In der Konfiguration des API-Posteingangs die **Webhook-URL** eintragen:

```
https://microsoft-teams-bridge.ezyaa.de/api/chatwoot/webhook
```

4. **Account ID** und **Inbox ID** notieren — beide werden im Admin-Interface der Bridge benötigt.

Der Webhook wird nur für **ausgehende Agenten-Nachrichten** genutzt (`message_created`, outgoing, nicht privat). Nachrichten von Teams nach Chatwoot laufen über die Chatwoot REST API.

### 2. Chatwoot API Access Token

Unter **Profil → Access Token** einen Token erzeugen und als `CHATWOOT_API_ACCESS_TOKEN` in der Bridge hinterlegen. Der Token braucht Zugriff auf Kontakte, Conversations und Nachrichten.

## Tenant-Konfiguration (Admin)

Jeder Microsoft-Teams-Mandant (Azure AD Tenant) muss in der Bridge einem Chatwoot-Account und -Posteingang zugeordnet werden.

**Admin-UI:** [https://microsoft-teams-bridge.ezyaa.de/api/admin/](https://microsoft-teams-bridge.ezyaa.de/api/admin/)

Beim ersten Aufruf den `ADMIN_API_TOKEN` eingeben (wird im Browser gespeichert).

| Feld | Beschreibung |
|------|--------------|
| **Name** | Anzeigename des Mandanten (z. B. Kundenname) |
| **Teams Tenant ID** | Azure AD Tenant ID (`tid` aus dem Teams-Kontext) |
| **Chatwoot Account ID** | Numerische Account-ID aus Chatwoot |
| **Chatwoot Inbox ID** | ID des API-Posteingangs aus Schritt 1 |

Ohne dieses Mapping kann die Bridge weder eingehende Teams-Nachrichten zuordnen noch Webhook-Antworten an den richtigen Teams-Chat zurücksenden.

## Azure Bot Registration

In der Azure Bot Registration den **Messaging Endpoint** setzen:

```
https://microsoft-teams-bridge.ezyaa.de/api/messages
```

Credentials (`MICROSOFT_APP_ID`, `MICROSOFT_APP_PASSWORD`, `MICROSOFT_APP_TENANT_ID`) als Umgebungsvariablen hinterlegen.

## Umgebungsvariablen

Kopie von `.env.example` anlegen und Werte setzen:

| Variable | Beschreibung |
|----------|--------------|
| `MICROSOFT_APP_ID` | Azure Bot Application ID |
| `MICROSOFT_APP_PASSWORD` | Azure Bot Client Secret |
| `MICROSOFT_APP_TENANT_ID` | Azure AD Tenant ID des Bot-Service |
| `CHATWOOT_BASE_URL` | Chatwoot-Instanz, z. B. `https://chatwoot.ezyaa.de` |
| `CHATWOOT_API_ACCESS_TOKEN` | Chatwoot Personal Access Token |
| `BRIDGE_BASE_URL` | Öffentliche URL der Bridge, z. B. `https://microsoft-teams-bridge.ezyaa.de` |
| `ADMIN_API_TOKEN` | Bearer-Token für die Admin-API |
| `PORT` | Server-Port (Standard: `3978`) |
| `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE` | PostgreSQL für Tenant- und Conversation-Mappings |

Optional: `PROACTIVE_API_TOKEN` für den Endpoint `/api/proactive/send` (falls abweichend vom Admin-Token).

## Endpoints

| Methode | Pfad | Zweck |
|---------|------|-------|
| `GET` | `/health` | Health Check |
| `POST` | `/api/messages` | Bot Framework (Teams) |
| `POST` | `/api/chatwoot/webhook` | Chatwoot Webhook (Agent-Antworten) |
| `GET` | `/api/admin/` | Tenant-Admin-UI |
| `POST` | `/api/proactive/send` | Proaktive DM an Teams-User (Bearer-Token) |

## Lokale Entwicklung

```bash
npm install
cp .env.example .env   # Werte ausfüllen
npm run dev
```

## Docker

```bash
docker compose up --build
```

## Teams App Manifest

Das Teams-App-Manifest liegt unter `manifest/manifest.json`. Nach Anpassung der `botId` und Icons das Paket **im Org-App-Katalog des Kunden-Tenants** hochladen (nicht nur Sideloading). Der proaktive Erstkontakt-Pfad sucht die App per `externalId = MICROSOFT_APP_ID` im Katalog.

## Kampagnen / Erstkontakt (Chatwoot → Teams)

Wenn Chatwoot eine ausgehende Nachricht an eine Conversation sendet, für die noch kein Teams-Mapping existiert (typisch: Kampagnen-Willkommens-DM), löst die Bridge den Teams-User über `contact.identifier` (= Azure AD Object ID) auf, installiert die App still, öffnet den Bot↔User-Chat und speichert das Mapping. Folge-Nachrichten und User-Antworten landen in derselben Chatwoot-Conversation.

## Graph Application Permissions (proaktiver Pfad)

In der Azure App Registration der Bridge (Application permissions, Admin-Consent im Kunden-Tenant):

| Permission | Zweck |
|------------|-------|
| `AppCatalog.Read.All` | Teams-App im Org-Katalog finden |
| `TeamsAppInstallation.ReadWriteSelfForUser.All` | Stille App-Installation für den User |
| `TeamsAppInstallation.ReadForUser.All` | Installation inkl. Chat-Lookup |
| `Chat.Read.All` | Optionaler Chat-Fallback |

Der Bot Framework `serviceUrl` für Erstkontakte ist auf EMEA (`https://smba.trafficmanager.net/emea/`) gesetzt.

## Troubleshooting

| Symptom | Mögliche Ursache |
|---------|------------------|
| Teams-Nachricht kommt nicht in Chatwoot an | Tenant nicht im Admin angelegt, falscher `CHATWOOT_API_ACCESS_TOKEN` oder falsche Inbox ID |
| Agent-/Kampagnen-Antwort kommt nicht in Teams an | Webhook-URL in Chatwoot fehlt/falsch; Kontakt ohne `identifier` (AAD Object ID); Teams-App nicht im Org-Katalog; Graph-Permissions fehlen |
| `No tenant configured for Teams tenant ID` | Teams Tenant ID im Admin fehlt oder ist falsch |
| `No tenant configured for Chatwoot account` | Chatwoot Account ID im Admin stimmt nicht mit dem Webhook-Account überein |
| Doppelte Chatwoot-Conversations bei Reply | Mapping-Fallback fehlgeschlagen — prüfen, ob `teams_bot_conversation_mappings` für den User existiert |
