# Cube Database Compatibility

This context defines the language used when Cube describes database targets, compatibility modes, driver transport, and SQL dialect selection.

## Language

**Kingbase Target**:
A first-class Cube database target for a KingbaseES compatibility mode. The current Kingbase Targets are **Kingbase PG Target** and **Kingbase Oracle Target**.
_Avoid_: Kingbase test alias, Kingbase profile

**Kingbase PG Target**:
The Kingbase Target for KingbaseES PG compatibility mode. It uses Postgres-compatible transport and Postgres SQL semantics.
_Avoid_: Kingbase PostgreSQL mode, PG alias

**Kingbase Oracle Target**:
The Kingbase Target for KingbaseES Oracle compatibility mode. It uses Postgres-compatible transport and Oracle SQL semantics.
_Avoid_: Oracle-over-Postgres hack, Oracle alias

**Driver Transport**:
The database protocol and driver implementation Cube uses to connect to and execute against a database target.
_Avoid_: Driver dialect, SQL mode

**SQL Dialect**:
The SQL semantics Cube uses when generating queries for a database target.
_Avoid_: Driver transport, protocol

**Generated Time Series**:
A SQL Dialect capability where a database target can produce a time series from query-derived time bounds when a request has no explicit date range.
_Avoid_: Static time series fixture, placeholder normalization

**Kingbase Oracle Placeholder Normalization**:
The Kingbase Oracle Target's binding boundary where Oracle-style placeholders are converted into placeholders accepted by the Postgres-compatible Driver Transport.
_Avoid_: Global Oracle placeholder rewrite, Postgres driver placeholder rewrite

## Example Dialogue

Developer: Should Kingbase Oracle use the Oracle driver?

Domain expert: No. The **Kingbase Oracle Target** uses Postgres-compatible **Driver Transport** but Oracle **SQL Dialect** because that is how this KingbaseES compatibility mode is reached and queried.

Developer: Is Kingbase PG just a Postgres test?

Domain expert: No. The **Kingbase PG Target** is a first-class **Kingbase Target**, even though it shares Postgres-compatible **Driver Transport** and Postgres **SQL Dialect**.

Developer: Should we change all Oracle placeholders to Postgres placeholders?

Domain expert: No. **Kingbase Oracle Placeholder Normalization** belongs only to the **Kingbase Oracle Target** because true Oracle and true Postgres keep their existing binding behavior.

Developer: Is missing date-range support in a rolling-window query a placeholder problem?

Domain expert: No. That belongs to **Generated Time Series** in the **SQL Dialect**; placeholder normalization only concerns values crossing into the **Driver Transport**.
