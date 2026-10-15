`lambda/template.yaml` prepara once Lambdas, catorce rutas HTTP y roles IAM/logs separados. La Lambda `auth` sirve cuatro rutas y dispone de 512 MiB para scrypt.

Los compradores usan una cookie de sesión verificada por los handlers contra PostgreSQL. API Gateway no exige AWS_IAM al navegador. IAM gobierna los roles de ejecución y los permisos de invocación de las funciones.

`npm run package:lambda` genera los ZIP y la plantilla sin desplegar. `npm run deploy:lambda` publica el stack `nexo-lab` en Ohio con el perfil homónimo. La configuración pública está en `lambda/config.json`; las salidas quedan en `lambda/outputs.json`.

La plantilla también crea CloudFront y un bucket privado para servir React y API bajo el mismo origen HTTPS. Cada función lee exclusivamente el secreto PostgreSQL/SSH de este laboratorio en Secrets Manager. La conexión SSH usa un usuario sin shell, restringido a `127.0.0.1:5433` en el VPS, y verifica su huella. Las migraciones 006/007 se aplicaron explícitamente con `scripts/configure-lab-database.mjs`, antes de publicar. Ver [README](../README.md).
