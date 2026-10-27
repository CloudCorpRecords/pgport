/**
 * pgport types.
 *
 * The core talks to PostgreSQL only through an injectable executor, so
 * every behaviour except the real `psql` subprocess can be tested with
 * a fake executor and no live database.
 */

/** Parsed pieces of a postgres:// or postgresql:// connection string. */
export interface PgConnectionInfo {
  host: string;
  /** TCP port; 5432 when the URL does not carry one. */
  port: number;
  /** Database name, taken from the URL path. */
  database: string;
  /** Username from the URL userinfo, when present. */
  user?: string;
}

/**
 * Anything that can run one SQL statement and return its rows.
 * The default implementation shells out to `psql`; tests inject a fake.
 */
export interface QueryExecutor {
  runQuery(sql: string): Promise<Array<Record<string, unknown>>>;
}

/** One table and the columns found for it, in ordinal order. */
export interface TableColumns {
  schema: string;
  table: string;
  columns: string[];
}
