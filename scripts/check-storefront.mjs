import { chromium, expect as baseExpect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
const base = process.env.TEST_URL ?? 'http://127.0.0.1:3010';
const expect = baseExpect.configure({ timeout: 45000 });
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(45000);
  const invoked = new Set(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    const name = response.headers()['x-lambda-function'];
    if (name) invoked.add(name);
  });
  const email = `browser-${Date.now()}@example.test`;
  const password = `Prueba-${randomUUID()}!`;
  await page.goto(base);
  await expect(page.getByRole('heading', { name: 'Iniciá sesión' })).toBeVisible();
  await page.screenshot({ path: '/tmp/nexo-login-desktop.png' });
  await page.getByRole('button', { name: 'Crear cuenta', exact: true }).click();
  await page.getByLabel('Nombre completo').fill('Comprador de prueba');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Crear cuenta', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cerrar sesión', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Creá tu cuenta' })).toBeVisible();
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill('contraseña-incorrecta');
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Email o contraseña incorrectos');
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await expect(page.locator('.shop-product').first()).toBeVisible();
  await page.locator('.product-visual').first().click();
  await page.getByRole('button', { name: 'Agregar al carrito', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Abrir carrito, 1 artículos' })).toBeVisible();
  await page.getByRole('button', { name: 'Abrir carrito, 1 artículos' }).click();
  await page.getByRole('button', { name: /^Aumentar / }).click();
  await expect(page.getByRole('dialog', { name: 'Tu carrito (2)' })).toBeVisible();
  await page.getByRole('button', { name: 'Continuar al pedido' }).click();
  await page.getByLabel('Calle y número').fill('Prueba 123');
  await page.getByLabel('Ciudad', { exact: true }).fill('Buenos Aires');
  await page.getByLabel('Código postal').fill('1000');
  await page.getByRole('button', { name: 'Guardar dirección', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Dirección de entrega' })).toContainText(
    'Prueba 123',
  );
  await page.getByRole('button', { name: 'Confirmar pedido', exact: true }).click();
  await expect(page.getByText('¡Tu pedido está en marcha!')).toBeVisible();
  const orderId = (await page.locator('.order-success strong').first().innerText()).replace(
    '#',
    '',
  );
  await expect(page.locator('.order-success li')).toHaveCount(1);
  await expect(page.locator('.order-success li')).toContainText('2 ×');
  await page.getByRole('button', { name: 'Seguir explorando', exact: true }).last().click();
  await page.locator('.shop-header-actions .owner-link').click();
  await page
    .locator('.order-row')
    .filter({ hasText: '#' + orderId })
    .click();
  await expect(page.getByRole('heading', { name: 'Pedido #' + orderId }).last()).toBeVisible();
  await expect(page.locator('.order-success li')).toContainText('2 ×');
  await page.getByRole('button', { name: 'Cerrar ventana' }).click();
  await expect(page.getByRole('button', { name: 'Abrir carrito, 0 artículos' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/nexo-storefront-mobile.png', fullPage: true });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw Error('Overflow horizontal móvil');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '/tmp/nexo-storefront-desktop.png', fullPage: false });
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Iniciá sesión', exact: true })).toBeVisible();
  const forbidden = await page.request.get(base + '/api/v1/cart');
  expect(forbidden.status()).toBe(401);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/nexo-login-mobile.png', fullPage: true });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw Error('Overflow en login móvil');
  expect(errors).toEqual([]);
  expect(invoked.size).toBe(11);
  console.log(
    JSON.stringify(
      {
        passed: true,
        orderId,
        functions: [...invoked],
        checks: [
          'signup, logout y login',
          'contraseña incorrecta',
          'nueva dirección',
          'persistencia de sesión y carrito al recargar',
          'modificar carrito',
          'confirmar',
          'detalle del pedido',
          'carrito vacío',
          'móvil sin overflow',
          'sin errores JS',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
