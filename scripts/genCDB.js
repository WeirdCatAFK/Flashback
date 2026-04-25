#!/usr/bin/env node
// Generates a ChartDB metadata JSON from the SQLite database.
// Usage: npm run genCDB [-- --db <path>]
// Output: chartdb.json in the project root

import Database from 'better-sqlite3';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

const args = process.argv.slice(2);
const dbFlagIndex = args.indexOf('--db');
const dbPath = dbFlagIndex !== -1
  ? resolve(args[dbFlagIndex + 1])
  : resolve('data/dreams.db');

const db = new Database(dbPath, { readonly: true });

const query = `
WITH fk_info AS (
  SELECT
      json_group_array(
          json_object(
              'schema', '',
              'table', m.name,
              'column', fk."from",
              'foreign_key_name',
                  'fk_' || m.name || '_' || fk."from" || '_' || fk."table" || '_' || fk."to",
              'reference_schema', '',
              'reference_table', fk."table",
              'reference_column', fk."to",
              'fk_def',
                  'FOREIGN KEY (' || fk."from" || ') REFERENCES ' || fk."table" || '(' || fk."to" || ')' ||
                  ' ON UPDATE ' || fk.on_update || ' ON DELETE ' || fk.on_delete
          )
      ) AS fk_metadata
  FROM
      sqlite_master m
  JOIN
      pragma_foreign_key_list(m.name) fk
  ON
      m.type = 'table'
), pk_info AS (
  SELECT
      json_group_array(
          json_object(
              'schema', '',
              'table', pk.table_name,
              'field_count', pk.field_count,
              'column', pk.pk_column,
              'pk_def', 'PRIMARY KEY (' || pk.pk_column || ')'
          )
      ) AS pk_metadata
  FROM
  (
      SELECT
          m.name AS table_name,
          COUNT(p.name) AS field_count,
          GROUP_CONCAT(p.name) AS pk_column
      FROM
          sqlite_master m
      JOIN
          pragma_table_info(m.name) p
      ON
          m.type = 'table' AND p.pk > 0
      GROUP BY
          m.name
  ) pk
), indexes_metadata AS (
  SELECT
      json_group_array(
          json_object(
              'schema', '',
              'table', m.name,
              'name', idx.name,
              'column', ic.name,
              'index_type', 'B-TREE',
              'cardinality', null,
              'size', null,
              'unique', (CASE WHEN idx."unique" = 1 THEN true ELSE false END),
              'direction', '',
              'column_position', ic.seqno + 1
          )
      ) AS indexes_metadata
  FROM
      sqlite_master m
  JOIN
      pragma_index_list(m.name) idx
  ON
      m.type = 'table'
  JOIN
      pragma_index_info(idx.name) ic
), cols AS (
  SELECT
      json_group_array(
          json_object(
              'schema', '',
              'table', m.name,
              'name', p.name,
              'type',
                  CASE
                      WHEN INSTR(LOWER(p.type), '(') > 0 THEN
                          SUBSTR(LOWER(p.type), 1, INSTR(LOWER(p.type), '(') - 1)
                      ELSE LOWER(p.type)
                  END,
              'ordinal_position', p.cid,
              'nullable', (CASE WHEN p."notnull" = 0 THEN true ELSE false END),
              'collation', '',
              'character_maximum_length',
                  CASE
                      WHEN LOWER(p.type) LIKE 'char%' OR LOWER(p.type) LIKE 'varchar%' THEN
                          CASE
                              WHEN INSTR(p.type, '(') > 0 THEN
                                  REPLACE(SUBSTR(p.type, INSTR(p.type, '(') + 1, LENGTH(p.type) - INSTR(p.type, '(') - 1), ')', '')
                              ELSE 'null'
                          END
                      ELSE 'null'
                  END,
              'precision',
              CASE
                  WHEN LOWER(p.type) LIKE 'decimal%' OR LOWER(p.type) LIKE 'numeric%' THEN
                      CASE
                          WHEN instr(p.type, '(') > 0 THEN
                              json_object(
                                  'precision', CAST(substr(p.type, instr(p.type, '(') + 1, instr(p.type, ',') - instr(p.type, '(') - 1) AS INTEGER),
                                  'scale', CAST(substr(p.type, instr(p.type, ',') + 1, instr(p.type, ')') - instr(p.type, ',') - 1) AS INTEGER)
                              )
                          ELSE null
                      END
                  ELSE null
              END,
              'default', COALESCE(REPLACE(p.dflt_value, '"', '\"'), ''),
              'is_identity',
              CASE
                  WHEN p.pk = 1 AND LOWER(p.type) LIKE '%int%' THEN json('true')
                  WHEN LOWER((SELECT sql FROM sqlite_master WHERE name = m.name)) LIKE '%' || p.name || '%autoincrement%' THEN json('true')
                  ELSE json('false')
              END
          )
      ) AS cols_metadata
  FROM
      sqlite_master m
  JOIN
      pragma_table_info(m.name) p
  ON
      m.type in ('table', 'view')
), tbls AS (
  SELECT
      json_group_array(
          json_object(
              'schema', '',
              'table', m.name,
              'rows', -1,
              'type', 'table',
              'engine', '',
              'collation', ''
          )
      ) AS tbls_metadata
  FROM
      sqlite_master m
  WHERE
      m.type in ('table', 'view')
), views AS (
  SELECT
      json_group_array(
          json_object(
              'schema', '',
              'view_name', m.name
          )
      ) AS views_metadata
  FROM
      sqlite_master m
  WHERE
      m.type = 'view'
)
SELECT
replace(replace(replace(
      json_object(
          'fk_info', (SELECT fk_metadata FROM fk_info),
          'pk_info', (SELECT pk_metadata FROM pk_info),
          'columns', (SELECT cols_metadata FROM cols),
          'indexes', (SELECT indexes_metadata FROM indexes_metadata),
          'tables', (SELECT tbls_metadata FROM tbls),
          'views', (SELECT views_metadata FROM views),
          'database_name', 'sqlite',
          'version', sqlite_version()
      ),
      '\"', '"'),'"[', '['), ']"', ']'
) AS metadata_json_to_import;
`;

const row = db.prepare(query).get();
db.close();

const outPath = resolve('chartdb.json');
writeFileSync(outPath, row.metadata_json_to_import, 'utf8');
console.log(`ChartDB metadata written to ${outPath}`);
