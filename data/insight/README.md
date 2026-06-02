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

Create or check one collection by name and compare it to a schema file in `data/insight/schemas/insight`:

```bash
npm run create:insightdata:csv -- Vehicles --scope contact --type custom
```

By default this resolves schema path:

```text
data/insight/schemas/insight/dd_<CollectionName>_schema.csv
```

Override schema file path:

```bash
npm run create:insightdata:csv -- Vehicles --schema data/insight/schemas/insight/dd_Vehicles_schema.csv
```

Note: Dotdigital Insight Data API exposes schema read (`GET`) but no schema write endpoint, so missing fields are reported and should be introduced via record import.

Import records from per-collection CSV files:

```bash
npm run import:insightdata:csv -- data/insight/schemas/collections.csv data/insight/records
```

Validate import files without writing data:

```bash
npm run import:insightdata:csv -- data/insight/schemas/collections.csv data/insight/records --dry-run
```

Seed a test contact with all fields from `dd_Customers_schema.csv`:

```bash
npm run import:test:contact
```

Apply test contact import for `jacob.stapleton@cambriaautos.co.uk`:

```bash
npm run import:test:contact:apply
```

Seed a test Vehicles Insight Data record for `jacob.stapleton@cambriaautos.co.uk`:

```bash
npm run import:test:vehicle
```

Apply the Vehicles test record import:

```bash
npm run import:test:vehicle:apply
```

Sync VehicleDates schema from CSV (create collection if missing, then compare schema):

```bash
npm run sync:schema:vehicledates
```

Apply VehicleDates schema sync by seeding a test record to materialize missing fields:

```bash
npm run sync:schema:vehicledates:apply
```

Build a joined VehicleMarketingEvents record from Vehicles + VehicleDates schemas (dry run):

```bash
npm run import:test:vehiclemarketingevents
```

Apply VehicleMarketingEvents test record import for `jacob.stapleton@cambriaautos.co.uk`:

```bash
npm run import:test:vehiclemarketingevents:apply
```
