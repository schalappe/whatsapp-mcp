# PRD - WhatsApp Read-Only MCP Connector

## 1. Contexte

L'utilisateur veut permettre a des agents compatibles MCP, comme Codex, Claude ou autres, d'acceder en lecture seule a son historique WhatsApp personnel pour analyser des conversations, retrouver du contexte et proposer des reponses. L'usage ne doit jamais automatiser l'envoi de messages.

L'approche WhatsApp Business Cloud API est exclue car elle necessite un compte business. L'approche Computer Use est insuffisante car elle distingue mal les messages de l'utilisateur et ceux des interlocuteurs.

## 2. Objectif

Creer un connecteur MCP WhatsApp personnel, strictement read-only, qui expose des outils de consultation structuree des messages WhatsApp en distinguant explicitement :

- les messages envoyes par l'utilisateur ;
- les messages envoyes par les interlocuteurs ;
- les conversations individuelles ;
- les groupes ;
- les dates, participants et metadonnees necessaires a l'analyse.

## 3. Non-objectifs

Le systeme ne doit pas :

- envoyer de messages WhatsApp ;
- modifier, supprimer ou telecharger automatiquement des messages ;
- exposer un serveur HTTP ouvert sur le reseau ;
- entrainer ou preparer un dataset LLM dans cette premiere version ;
- contourner les confirmations ou politiques de securite des clients MCP ;
- fournir un acces illimite a tout l'historique sans pagination ni limites.

## 4. Utilisateurs cibles

- Utilisateur personnel souhaitant analyser ses conversations WhatsApp.
- Agents MCP locaux utilises par l'utilisateur : Codex, Claude Desktop, Cursor, assistants personnels.
- Aucun usage multi-utilisateur n'est prevu en V1.

## 5. Architecture proposee

```text
whatsapp-reader-go
  -> connexion WhatsApp Web multi-device via whatsmeow
  -> synchronisation messages vers SQLite local
  -> aucune API d'ecriture
  -> aucun endpoint public

whatsapp-mcp-readonly-ts
  -> serveur MCP stdio
  -> lecture directe SQLite
  -> tools strictement read-only
  -> limites, redaction, audit log

local SQLite
  -> messages
  -> chats
  -> contacts/participants
  -> sync metadata
```

## 6. Exigences fonctionnelles

### 6.1 Synchronisation WhatsApp

Le collecteur doit :

- connecter un compte WhatsApp personnel via QR code ;
- stocker les messages dans SQLite ;
- conserver `is_from_me` pour chaque message ;
- conserver `chat_jid`, `sender_jid`, `timestamp`, `content`, `message_id` ;
- gerer conversations directes et groupes ;
- reprendre la synchronisation apres redemarrage ;
- ne jamais envoyer de message.

### 6.2 Outils MCP

Le serveur MCP doit exposer uniquement des outils read-only.

#### `list_chats`

Liste les conversations disponibles.

Parametres :

- `query?: string`
- `limit?: number`
- `cursor?: string`
- `include_last_message?: boolean`

#### `search_messages`

Recherche dans les messages.

Parametres :

- `chat_id?: string`
- `query?: string`
- `after?: string`
- `before?: string`
- `sender_role?: "me" | "other" | "any"`
- `limit?: number`
- `cursor?: string`

#### `get_thread_context`

Retourne le contexte autour d'un message ou d'une periode.

Parametres :

- `chat_id: string`
- `around_message_id?: string`
- `after?: string`
- `before?: string`
- `limit_before?: number`
- `limit_after?: number`

#### `get_chat_summary_input`

Retourne un extrait borne et structure pour analyse par l'agent.

Parametres :

- `chat_id: string`
- `after?: string`
- `before?: string`
- `max_messages?: number`

### 6.3 Format de reponse

Chaque message retourne doit etre structure ainsi :

```json
{
  "id": "message-id",
  "chat_id": "chat-jid",
  "timestamp": "2026-07-04T12:34:56Z",
  "role": "me",
  "sender_jid": "xxx@s.whatsapp.net",
  "sender_display_name": "Alice",
  "content": "message text",
  "message_type": "text"
}
```

Le champ `role` est obligatoire et doit toujours valoir :

- `"me"` pour les messages de l'utilisateur ;
- `"other"` pour les messages des interlocuteurs.

## 7. Exigences de securite

Le systeme doit :

- etre read-only par conception ;
- ne contenir aucun outil `send_message`, `send_file`, `delete_message` ou equivalent ;
- ne pas exposer de serveur HTTP reseau en V1 ;
- utiliser SQLite avec permissions locales restrictives ;
- limiter le nombre de messages retournes par appel ;
- journaliser les appels MCP dans un audit log local ;
- permettre une allowlist optionnelle de conversations ;
- permettre de masquer numeros de telephone et JID dans les reponses ;
- refuser les requetes trop larges sans filtre ou limite explicite.

## 8. Configuration

Exemple de configuration :

```toml
[whatsapp]
database_path = "/Users/me/.local/share/whatsapp-reader/messages.db"
readonly = true

[privacy]
redact_phone_numbers = true
redact_jids = true
max_messages_per_call = 100

[access]
allowed_chat_ids = []
blocked_chat_ids = []

[audit]
enabled = true
log_path = "/Users/me/.local/share/whatsapp-reader/audit.log"
```

## 9. Criteres d'acceptation

La V1 est acceptee si :

- l'utilisateur peut scanner un QR code et synchroniser son compte WhatsApp ;
- les messages sont stockes localement dans SQLite ;
- chaque message stocke distingue correctement `me` vs `other` ;
- le serveur MCP demarre en stdio ;
- un client MCP peut appeler `list_chats`, `search_messages` et `get_thread_context` ;
- aucun outil d'ecriture WhatsApp n'est expose ;
- une requete large sans limite est refusee ou bornee ;
- les logs d'audit indiquent quel outil a ete appele, quand, avec quels filtres ;
- le projet inclut des tests sur la separation `me` / `other`.

## 10. Plan de realisation

### Phase 1 - Collecteur read-only

- Initialiser projet Go.
- Integrer `whatsmeow`.
- Authentification QR code.
- Creation SQLite.
- Synchronisation messages.
- Persistance `is_from_me`.

### Phase 2 - Serveur MCP

- Initialiser projet TypeScript.
- Ajouter SDK MCP.
- Lire SQLite en read-only.
- Implementer `list_chats`.
- Implementer `search_messages`.
- Implementer `get_thread_context`.

### Phase 3 - Securite et limites

- Ajouter pagination.
- Ajouter limites globales.
- Ajouter redaction.
- Ajouter allowlist/blocklist.
- Ajouter audit log.
- Ajouter tests de non-regression sur absence d'outils d'ecriture.

### Phase 4 - Packaging local

- Documentation d'installation.
- Exemple de config Codex.
- Exemple de config Claude Desktop.
- Script de demarrage local.
- Procedure de revocation / suppression des donnees locales.

## 11. Questions ouvertes

- Faut-il indexer le contenu en FTS5 pour ameliorer la recherche ?
- Faut-il stocker les medias ou seulement leurs metadonnees ?
- Faut-il une interface locale pour gerer allowlist/blocklist ?
- Faut-il supporter plusieurs comptes WhatsApp ?
- Faut-il chiffrer SQLite au repos en V1 ou reporter a V2 ?
