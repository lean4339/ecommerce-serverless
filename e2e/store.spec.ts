// Flujos principales por la UI (stack local con DynamoDB Local).
import { test, expect } from '@playwright/test';
import { live, newAccount } from './helpers';

test.skip(live, 'El flujo completo por UI corre contra el stack local');

test('Tienda: registro, catálogo, filtros, ficha, carrito, dirección y pedido', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const account = newAccount();

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Iniciá sesión' })).toBeVisible();
  await page.getByRole('button', { name: 'Crear cuenta', exact: true }).click();
  await page.getByLabel('Nombre completo').fill(account.full_name);
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Crear cuenta', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cerrar sesión', exact: true })).toBeVisible();

  // Logout + login (con contraseña incorrecta primero)
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Contraseña', { exact: true }).fill('incorrecta-123');
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Email o contraseña incorrectos');
  await page.getByLabel('Contraseña', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();

  // Catálogo y paginación (60 productos, 24 por página)
  await expect(page.locator('.shop-product')).toHaveCount(24);
  await expect(page.getByText('Página 1 de 3')).toBeVisible();
  const firstOnPage1 = await page.locator('.shop-product').first().innerText();
  await page.getByRole('button', { name: 'Página siguiente de tienda' }).click();
  await expect(page.getByText('Página 2 de 3')).toBeVisible();
  await expect(page.locator('.shop-product').first()).not.toHaveText(firstOnPage1);
  await page.getByRole('button', { name: 'Página siguiente de tienda' }).click();
  await expect(page.locator('.shop-product')).toHaveCount(12);
  await page.getByRole('button', { name: 'Página anterior de tienda' }).click();
  await expect(page.getByText('Página 2 de 3')).toBeVisible();

  // Filtros: categoría y búsqueda
  await page.getByLabel('Categoría de productos').selectOption('3');
  await expect(page.locator('.shop-product')).toHaveCount(20);
  await page.getByLabel('Limpiar filtros').click();
  await page.getByLabel('Buscar en la tienda').fill('Termo');
  await page.getByLabel('Buscar en la tienda').press('Enter');
  await expect(page.locator('.shop-product').first()).toContainText('Termo');
  await expect(page.locator('.shop-product')).toHaveCount(8);

  // Ficha y carrito
  await page.locator('.product-visual').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Agregar al carrito', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Abrir carrito, 1 artículos' }).click();
  await page.getByRole('button', { name: /^Aumentar / }).click();
  await expect(page.getByRole('dialog', { name: 'Tu carrito (2)' })).toBeVisible();

  // Dirección y pedido
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
  await expect(page.locator('.order-success li')).toContainText('2 ×');

  // Mis pedidos -> detalle
  await page.getByRole('button', { name: 'Seguir explorando', exact: true }).last().click();
  await page.locator('.shop-header-actions .owner-link').click();
  await page
    .locator('.order-row')
    .filter({ hasText: '#' + orderId })
    .click();
  await expect(page.getByRole('heading', { name: 'Pedido #' + orderId }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar ventana' }).click();
  await expect(page.getByRole('button', { name: 'Abrir carrito, 0 artículos' })).toBeVisible();

  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Iniciá sesión', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
