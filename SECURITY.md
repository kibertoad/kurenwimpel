# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub:
[open a private security advisory](https://github.com/kibertoad/kurenwimpel/security/advisories/new)
on this repository. Please do not open a public issue or pull request for a
suspected vulnerability.

Include the affected package and version, what an attacker can do, and the
smallest ruleset, context or request that shows it. You will get an answer in
the advisory thread, and the fix is published with a GitHub security advisory
once a patched release is out.

## Supported versions

Every `@kurenwimpel/*` package is pre-1.0. Only the latest minor release of each
package receives security fixes; upgrade to it to get one.

| Version              | Supported |
| -------------------- | --------- |
| latest `0.x` minor   | yes       |
| older `0.x` releases | no        |

## Scope

How to deploy the libraries securely (authenticating the HTTP provider, who can
read a ruleset, keeping personal data out of segments and targets) is covered in
the [Security section of the README](README.md#security).
