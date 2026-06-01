# Dotdigital Integration Starter (Node.js)

This project provides a Node.js starter for integrating with the Dotdigital API and building Insight Data payloads.

## What is included

- Dotdigital API client with basic authentication
- Contact service for contact create/upsert/get operations
- Insight data service for collections, records, and bulk imports
- Insight builder service for transforming your source data into Dotdigital-friendly records
- A runnable sample in `src/index.js`

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your environment file:

```bash
copy .env.example .env
```

3. Update `.env` with your Dotdigital API credentials.

4. Run the sample:

```bash
npm start
```

## Services overview

- `DotdigitalClient` (`src/clients/dotdigitalClient.js`)
  - Central HTTP client with auth and error handling.

- `ContactService` (`src/services/contactService.js`)
  - `createContact(...)`
  - `upsertContactByIdentifier(...)`
  - `getContact(...)`

- `InsightDataService` (`src/services/insightDataService.js`)
  - `listCollections()`
  - `createCollection(...)`
  - `getCollectionSchema(...)`
  - `upsertContactRecord(...)`
  - `upsertAccountRecord(...)`
  - `bulkImport(...)`
  - `getBulkImportStatus(...)`

- `InsightBuilderService` (`src/services/insightBuilderService.js`)
  - `buildOrderRecord(...)`
  - `buildCatalogProductRecord(...)`
  - `buildRecordKey(...)`

## Important notes

- Keep `DOTDIGITAL_DRY_RUN=true` while validating your payload build logic.
- Ensure contacts exist before bulk importing contact-scoped insight data.
- Keep record IDs globally unique to avoid accidental record re-assignment across contacts.
- Confirm endpoint/field requirements in your Dotdigital account and schema strategy before production rollout.
