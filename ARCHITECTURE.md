<div align="center">

# ⚡ Nexo Store — E-commerce Serverless

**AWS Lambda · API Gateway · DynamoDB single-table · CloudFront**

![Lambda](https://img.shields.io/badge/AWS-Lambda-FF9900?logo=awslambda&logoColor=white)
![DynamoDB](https://img.shields.io/badge/DynamoDB-single--table-4053D6?logo=amazondynamodb&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-Node-3178C6?logo=typescript&logoColor=white)
![SAM](https://img.shields.io/badge/IaC-AWS%20SAM-232F3E?logo=amazonaws&logoColor=white)
![CI](https://img.shields.io/badge/CI%2FCD-GitHub%20Actions-2088FF?logo=githubactions&logoColor=white)

</div>

---

## 🏗️ Arquitectura

```mermaid
flowchart LR
    U[🧑 Usuario] --> CF[☁️ CloudFront]
    CF -->|/| S3[(🪣 S3 Frontend)]
    CF -->|/api/v1| GW[🚪 API Gateway HTTP]
    GW --> L1[λ list-products]
    GW --> L2[λ auth]
    GW --> L3[λ cart]
    GW --> L4[λ orders]
    GW --> L5[λ ... x11]
    L1 & L2 & L3 & L4 & L5 --> DDB[(⚡ DynamoDB<br/>single-table)]
```

## 🧠 Modelo de datos (single-table)

| Entidad                 | PK             | SK                         |
| ----------------------- | -------------- | -------------------------- |
| Producto                | `PRODUCT#<id>` | `META`                     |
| Por categoría (GSI1)    | `CAT#<id>`     | `PRODUCT#<name>`           |
| Catálogo popular (GSI2) | `CATALOG`      | `<ventas invertidas>#<id>` |
| Sesiones / rate limit   | con **TTL**    | autolimpieza               |

> ✍️ Órdenes y signup con `TransactWriteItems`. Carrito con versión optimista.

## 🔥 La saga del N+1

|                     | Antes     | Después   |
| ------------------- | --------- | --------- |
| `list-products` p50 | 473 ms    | **21 ms** |
| Peor caso           | 13.5 s 💀 | **1.4 s** |
| Sockets saturados   | sí        | **0**     |

~250 queries en paralelo por categoría ➜ **una Query paginada sobre GSI2**.

## 🚀 Pipeline

`PR` ➜ lint · build · tests Dynamo · Playwright E2E ➜ `main` ➜ changeset seguro ➜ deploy ➜ smoke test en vivo

---

<div align="center"><sub>Hecho a las 3 AM con ☕ y cero vergüenza · Lean_Dev</sub></div>
