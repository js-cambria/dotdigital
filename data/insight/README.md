# Insight Data CSV Folder

Store your Insight Data CSV files here.

## Folder layout

- `data/insight/schemas/collections.csv`
  - Defines collections to create.
- `data/insight/records/<collectionName>.csv`
  - Contains records to import for each collection.

## Schema CSV format

`collections.csv` columns:

- `collectionName` (required)
- `collectionScope` (required): `contact` or `account`
- `collectionType` (required): use `custom` for custom collections

Example is provided in `data/insight/schemas/collections.example.csv`.

## Record CSV format

For `contact` collections, each row must include:

- `recordId`
- `contactIdentifier`
- any additional data columns to store on the record

For `account` collections, each row must include:

- `recordId`
- any additional data columns to store on the record

Examples are provided in:

- `data/insight/records/orders.example.csv`
- `data/insight/records/products.example.csv`

## Commands

Create collections from schema CSV:

```bash
npm run create:insightdata:csv -- data/insight/schemas/collections.csv
```

Import records from per-collection CSV files:

```bash
npm run import:insightdata:csv -- data/insight/schemas/collections.csv data/insight/records
```

Validate import files without writing data:

```bash
npm run import:insightdata:csv -- data/insight/schemas/collections.csv data/insight/records --dry-run
```
