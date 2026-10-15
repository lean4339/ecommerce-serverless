import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ShoppingBag,
  Search,
  ArrowUpRight,
  ArrowRight,
  ArrowLeft,
  X,
  Plus,
  Minus,
  Star,
  SlidersHorizontal,
  Truck,
  ShieldCheck,
  RefreshCw,
  Package,
  Headphones,
  Armchair,
  Shirt,
  Watch,
  Laptop,
  Camera,
  Bike,
  Coffee,
  Heart,
} from 'lucide-react';
import { api, money, number, type Row } from './data';
import AddressForm from './AddressForm';
import './shop.css';
type CartItem = {
  variant_id: string;
  product_id: string;
  name: string;
  color: string;
  size: string;
  price_cents: string;
  quantity: number;
  available: number;
};
function Illustration({ name, large = false }: { name: string; large?: boolean }) {
  const items = [Headphones, Armchair, Shirt, Watch, Laptop, Camera, Bike, Coffee, ShoppingBag];
  const seed = [...name].reduce((sum, c) => sum + c.charCodeAt(0), 0);
  const match = /keyboard|computer|monitor/i.test(name)
    ? Laptop
    : /chair|sofa/i.test(name)
      ? Armchair
      : /shirt|pants|hat|gloves/i.test(name)
        ? Shirt
        : /bike/i.test(name)
          ? Bike
          : /watch/i.test(name)
            ? Watch
            : /headphones/i.test(name)
              ? Headphones
              : null;
  const Icon = match ?? items[seed % items.length]!;
  return (
    <div
      aria-hidden="true"
      className={`shop-illustration tone-${seed % 5} ${large ? 'large' : ''}`}
    >
      <span className="illustration-orbit" />
      <span className="illustration-shadow" />
      <Icon strokeWidth={1.05} />
      <span className="illustration-label">
        nexo studio / {String(seed % 100).padStart(2, '0')}
      </span>
    </div>
  );
}
function Modal({
  title,
  children,
  close,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = ref.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={`shop-modal ${wide ? 'wide' : ''}`}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === ref.current) {
          close();
        }
      }}
    >
      <div className="shop-modal-header">
        <h2>{title}</h2>
        <button className="shop-icon" aria-label="Cerrar ventana" onClick={close}>
          <X />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export default function Shop() {
  const [filters, setFilters] = useState<Row | null>(null);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [brand, setBrand] = useState('');
  const [sort, setSort] = useState('popular');
  const [stock, setStock] = useState(false);
  const [rating, setRating] = useState('0');
  const [page, setPage] = useState(1);
  const [price, setPrice] = useState({ min: '', max: '' });
  const [bounds, setBounds] = useState({ min: '', max: '' });
  const [catalog, setCatalog] = useState<Row | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [product, setProduct] = useState<Row | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [productId, setProductId] = useState<string | null>(null);
  const [variant, setVariant] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [checkout, setCheckout] = useState(false);
  const [customer, setCustomer] = useState<Row | null>(null);
  const [address, setAddress] = useState('');
  const [customerLoading, setCustomerLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [order, setOrder] = useState<Row | null>(null);
  const [notice, setNotice] = useState('');
  const [cartVersion, setCartVersion] = useState(0);
  const [cartReady, setCartReady] = useState(false);
  const [savingCart, setSavingCart] = useState(false);
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [orders, setOrders] = useState<Row[]>([]);
  const [ordersError, setOrdersError] = useState('');
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [nextOrder, setNextOrder] = useState<string | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<Row | null>(null);
  const cartBusy = useRef(false);
  const catalogAnchor = useRef<HTMLElement>(null);
  const requestSequence = useRef(0);
  const mounted = useRef(true);
  const checking = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    api('/store/filters', { signal: controller.signal })
      .then(setFilters)
      .catch((e) => {
        if (e.name !== 'AbortError') {
          setError(e.message);
        }
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [retry]);
  const refreshCart = async () => {
    const r = await api('/cart');
    setCart(r.data.items);
    setCartVersion(r.data.version);
    setCartReady(true);
  };
  useEffect(() => {
    void refreshCart().catch((e) => setNotice(e.message));
  }, []);
  const saveCart = async (rows: CartItem[]) => {
    if (cartBusy.current || !cartReady) {
      return false;
    }
    cartBusy.current = true;
    setSavingCart(true);
    try {
      const r = await api('/cart', {
        method: 'PUT',
        body: JSON.stringify({
          version: cartVersion,
          items: rows.map((i) => ({ variant_id: i.variant_id, quantity: i.quantity })),
        }),
      });
      setCart(r.data.items);
      setCartVersion(r.data.version);
      return true;
    } catch (e) {
      setNotice((e as Error).message);
      await refreshCart().catch(() => {});
      return false;
    } finally {
      cartBusy.current = false;
      setSavingCart(false);
    }
  };
  const showOrders = async (before?: string) => {
    setOrdersOpen(true);
    setSelectedOrder(null);
    setOrdersError('');
    setOrdersLoading(true);
    try {
      const r = await api('/orders' + (before ? '?before_id=' + before : ''));
      setOrders((rows) => (before ? [...rows, ...r.data] : r.data));
      setNextOrder(r.next_before_id);
    } catch (e) {
      setOrdersError((e as Error).message);
    } finally {
      setOrdersLoading(false);
    }
  };
  const showOrder = async (id: string) => {
    setOrdersError('');
    setOrdersLoading(true);
    try {
      const r = await api('/orders/' + id);
      setSelectedOrder(r.data);
    } catch (e) {
      setOrdersError((e as Error).message);
    } finally {
      setOrdersLoading(false);
    }
  };
  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ sort, page: String(page), limit: '24' });
    if (q) {
      params.set('q', q);
    }
    if (category) {
      params.set('category_id', category);
    }
    if (brand) {
      params.set('brand_id', brand);
    }
    if (stock) {
      params.set('in_stock', 'true');
    }
    if (rating !== '0') {
      params.set('min_rating', rating);
    }
    if (bounds.min) {
      params.set('min_cents', bounds.min);
    }
    if (bounds.max) {
      params.set('max_cents', bounds.max);
    }
    api(`/store/products?${params}`, { signal: controller.signal })
      .then((r) => {
        if (!controller.signal.aborted) {
          setCatalog(r);
        }
      })
      .catch((e) => {
        if (e.name !== 'AbortError') {
          setError(e.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [q, category, brand, stock, rating, sort, page, bounds, retry]);
  useEffect(() => {
    if (!productId) {
      return;
    }
    const controller = new AbortController();
    setProduct(null);
    setDetailLoading(true);
    setDetailError('');
    setQuantity(1);
    api(`/store/products/${productId}`, { signal: controller.signal })
      .then((r) => {
        setProduct(r.data);
        setVariant(
          r.data.variants.find((v: Row) => BigInt(v.available_units) > 0n)?.id ??
            r.data.variants[0]?.id ??
            '',
        );
      })
      .catch((e) => {
        if (e.name !== 'AbortError') {
          setDetailError(e.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setDetailLoading(false);
        }
      });
    return () => controller.abort();
  }, [productId, retry]);
  const scrollCatalog = () =>
    catalogAnchor.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const reset = () => {
    setQ('');
    setSearch('');
    setCategory('');
    setBrand('');
    setStock(false);
    setRating('0');
    setBounds({ min: '', max: '' });
    setPrice({ min: '', max: '' });
    setPage(1);
  };
  const change = (fn: () => void) => {
    fn();
    setPage(1);
  };
  const chosen = product?.variants.find((v: Row) => v.id === variant);
  const cartCount = cart.reduce((n, i) => n + i.quantity, 0);
  const total = cart.reduce((n, i) => n + BigInt(i.price_cents) * BigInt(i.quantity), 0n);
  const add = async () => {
    if (!chosen || !product) {
      return;
    }
    const available = Math.min(Number(chosen.available_units), 1000);
    const existing = cart.find((i) => i.variant_id === chosen.id);
    if ((existing?.quantity ?? 0) + quantity > available) {
      setNotice('La cantidad supera el stock disponible.');
      return;
    }
    if (!existing && cart.length >= 50) {
      setNotice('El carrito admite hasta 50 variantes.');
      return;
    }
    const saved = await saveCart(
      existing
        ? cart.map((i) =>
            i.variant_id === chosen.id ? { ...i, quantity: i.quantity + quantity, available } : i,
          )
        : [
            ...cart,
            {
              variant_id: chosen.id,
              product_id: product.id,
              name: product.name,
              color: chosen.color,
              size: chosen.size,
              price_cents: chosen.price_cents,
              quantity,
              available,
            },
          ],
    );
    if (saved) {
      setNotice('Agregado a tu carrito');
      setProductId(null);
    }
  };
  const loadCustomer = async () => {
    const sequence = ++requestSequence.current;
    setCustomerLoading(true);
    setCustomer(null);
    setAddress('');
    setCheckoutError('');
    try {
      const r = await api('/store/customer');
      if (mounted.current && sequence === requestSequence.current) {
        setCustomer(r.data);
        setAddress(r.data.addresses[0]?.id ?? '');
      }
    } catch (e) {
      if (mounted.current && sequence === requestSequence.current) {
        setCheckoutError((e as Error).message);
      }
    } finally {
      if (mounted.current && sequence === requestSequence.current) {
        setCustomerLoading(false);
      }
    }
  };
  const beginCheckout = () => {
    setCartOpen(false);
    setCheckout(true);
    setOrder(null);
    void loadCustomer();
  };
  const buy = async () => {
    if (checking.current || !customer || !address || !cart.length || savingCart) {
      return;
    }
    checking.current = true;
    setSubmitting(true);
    setCheckoutError('');
    try {
      const storageKey = `nexo-checkout-${cartVersion}-${address}`;
      const key = sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
      sessionStorage.setItem(storageKey, key);
      const r = await api('/orders', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify({ address_id: address, cart_version: cartVersion }),
      });
      setOrder(r.data);
      setCart([]);
      sessionStorage.removeItem(storageKey);
      setRetry((r) => r + 1);
      await refreshCart().catch(() =>
        setNotice('Pedido guardado. No pudimos actualizar el carrito.'),
      );
    } catch (e) {
      setCheckoutError((e as Error).message);
    } finally {
      checking.current = false;
      setSubmitting(false);
    }
  };
  const applyPrice = () => {
    const parse = (value: string) => {
      if (!value.trim()) {
        return '';
      }
      if (!/^\d{1,15}([.,]\d{1,2})?$/.test(value.trim())) {
        throw new Error('Usá un precio válido, por ejemplo 1200,50.');
      }
      const [whole, decimal = ''] = value.trim().replace(',', '.').split('.');
      return (BigInt(whole!) * 100n + BigInt(decimal.padEnd(2, '0'))).toString();
    };
    try {
      const min = parse(price.min);
      const max = parse(price.max);
      if (min && max && BigInt(min) > BigInt(max)) {
        throw new Error('El mínimo supera al máximo.');
      }
      change(() => setBounds({ min, max }));
    } catch (e) {
      setNotice((e as Error).message);
    }
  };
  return (
    <div className="shop">
      <div className="shop-announcement">
        Objetos para todos los días. Ideas para salir de lo común.
        <span>
          Una tienda, miles de posibilidades <ArrowUpRight size={13} />
        </span>
      </div>
      <header className="shop-header">
        <a className="shop-brand" href="#/shop" onClick={reset}>
          nexo<span>store</span>
          <i>®</i>
        </a>
        <nav>
          <button
            onClick={() => {
              reset();
              scrollCatalog();
            }}
          >
            Explorar
          </button>
          <button
            onClick={() => {
              change(() => setSort('newest'));
              scrollCatalog();
            }}
          >
            Novedades
          </button>
          <button
            onClick={() => {
              change(() => setSort('popular'));
              scrollCatalog();
            }}
          >
            Más elegidos
          </button>
        </nav>
        <div className="shop-header-actions">
          <button className="owner-link" onClick={() => void showOrders()}>
            Mis pedidos <Package size={14} />
          </button>
          <button
            className="shop-bag"
            aria-label={`Abrir carrito, ${cartCount} artículos`}
            onClick={() => setCartOpen(true)}
          >
            <ShoppingBag size={21} />
            <span>{cartCount}</span>
          </button>
        </div>
      </header>
      <main className="shop-main">
        <section className="shop-hero">
          <div className="hero-copy">
            <div className="shop-overline">
              <span />
              CURADURÍA PARA TU DÍA A DÍA
            </div>
            <h1>
              Elegí algo
              <br />
              <em>distinto.</em>
            </h1>
            <p>
              Encontrá tu próximo favorito.
              <br />
              Diseño, tecnología y pequeños descubrimientos.
            </p>
            <button className="shop-button dark" onClick={scrollCatalog}>
              Explorar la colección <ArrowRight size={18} />
            </button>
            <div className="hero-foot">
              <span>01 / EL ARTE DE ELEGIR</span>
              <span>EST. 2026</span>
            </div>
          </div>
          <div className="hero-art">
            <div className="hero-disc" />
            <div className="hero-headphones">
              <Headphones strokeWidth={0.9} />
            </div>
            <div className="hero-sticker">
              BUENAS
              <br />
              ELECCIONES
              <br />
              <Star size={18} />
            </div>
            <span className="hero-caption">Tu mundo, a tu manera.</span>
            <span className="hero-vertical">THE EVERYDAY COLLECTION</span>
          </div>
        </section>
        <section className="shop-promises">
          <span>
            <Truck />
            Stock real por variante
          </span>
          <span>
            <ShieldCheck />
            Precios en pesos argentinos
          </span>
          <span>
            <RefreshCw />
            Nuevos descubrimientos
          </span>
        </section>
        <section ref={catalogAnchor} className="shop-catalog" id="catalogo">
          <div className="catalog-heading">
            <div>
              <span className="shop-overline">ENCONTRÁ TU PRÓXIMO FAVORITO</span>
              <h2>
                La colección<span>.</span>
              </h2>
            </div>
            <span>{catalog ? number(catalog.total) : '…'} productos</span>
          </div>
          <form
            className="shop-search"
            onSubmit={(e) => {
              e.preventDefault();
              change(() => setQ(search.trim()));
            }}
          >
            <Search size={19} />
            <input
              aria-label="Buscar en la tienda"
              placeholder="Buscá productos, materiales, ideas…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button className="shop-button dark" type="submit">
              Buscar <ArrowRight size={16} />
            </button>
          </form>
          <div className="shop-category-pills">
            <button
              className={!category ? 'active' : ''}
              onClick={() => change(() => setCategory(''))}
            >
              Todo
            </button>
            {filters?.categories
              .filter((c: Row) => BigInt(c.products) > 0n)
              .slice(0, 7)
              .map((c: Row) => (
                <button
                  className={category === c.id ? 'active' : ''}
                  key={c.id}
                  onClick={() => change(() => setCategory(c.id))}
                >
                  {c.name}
                </button>
              ))}
          </div>
          <div className="shop-catalog-layout">
            <aside className={`shop-filters ${filterOpen ? 'open' : ''}`}>
              <div className="filter-title">
                <strong>Encontrá lo tuyo</strong>
                <button className="shop-icon" onClick={reset} aria-label="Limpiar filtros">
                  <RefreshCw size={15} />
                </button>
              </div>
              <label>
                Categoría
                <select
                  aria-label="Categoría de productos"
                  value={category}
                  onChange={(e) => change(() => setCategory(e.target.value))}
                >
                  <option value="">Todas las categorías</option>
                  {filters?.categories.map((c: Row) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.products})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Marca
                <select value={brand} onChange={(e) => change(() => setBrand(e.target.value))}>
                  <option value="">Todas las marcas</option>
                  {filters?.brands.map((b: Row) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Precio (ARS)
                <div className="price-range">
                  <input
                    aria-label="Precio mínimo"
                    inputMode="decimal"
                    placeholder="Desde"
                    value={price.min}
                    onChange={(e) => setPrice((p) => ({ ...p, min: e.target.value }))}
                  />
                  <input
                    aria-label="Precio máximo"
                    inputMode="decimal"
                    placeholder="Hasta"
                    value={price.max}
                    onChange={(e) => setPrice((p) => ({ ...p, max: e.target.value }))}
                  />
                </div>
              </label>
              <button className="shop-button outline" onClick={applyPrice}>
                Aplicar precio
              </button>
              <label>
                Valoración
                <select value={rating} onChange={(e) => change(() => setRating(e.target.value))}>
                  <option value="0">Todas las valoraciones</option>
                  <option value="4">4 estrellas o más</option>
                  <option value="3">3 estrellas o más</option>
                </select>
              </label>
              <label className="stock-checkbox">
                <input
                  type="checkbox"
                  checked={stock}
                  onChange={(e) => change(() => setStock(e.target.checked))}
                />
                Solo con stock
              </label>
              <div className="filter-note">
                <Package size={21} />
                <strong>Una colección enorme.</strong>
                <p>Explorá categorías y descubrí productos que no estabas buscando.</p>
              </div>
            </aside>
            <div className="shop-products">
              <div className="shop-toolbar">
                <button
                  className="mobile-filter shop-button outline"
                  onClick={() => setFilterOpen((p) => !p)}
                >
                  <SlidersHorizontal size={16} />
                  Filtros
                </button>
                <span>{q ? `Resultados para “${q}”` : 'Elegidos para descubrir'}</span>
                <label>
                  Ordenar
                  <select
                    aria-label="Ordenar productos"
                    value={sort}
                    onChange={(e) => change(() => setSort(e.target.value))}
                  >
                    <option value="popular">Más vendidos</option>
                    <option value="trending">Más vistos</option>
                    <option value="newest">Novedades</option>
                    <option value="price_asc">Menor precio</option>
                    <option value="price_desc">Mayor precio</option>
                    <option value="rating">Mejor valoración</option>
                  </select>
                </label>
              </div>
              {loading ? (
                <div className="shop-loading">
                  <RefreshCw className="spin" />
                  Buscando tus próximos favoritos…
                </div>
              ) : error ? (
                <div role="alert" className="shop-empty">
                  <h3>No pudimos cargar la colección</h3>
                  <p>{error}</p>
                  <button className="shop-button dark" onClick={() => setRetry((r) => r + 1)}>
                    Volver a intentar
                  </button>
                </div>
              ) : catalog?.data.length ? (
                <div className="shop-product-grid">
                  {catalog.data.map((p: Row) => (
                    <article className="shop-product" key={p.id}>
                      <button
                        className="product-visual"
                        aria-label={`Ver ${p.name}`}
                        onClick={() => setProductId(p.id)}
                      >
                        <Illustration name={p.name} />
                        <span className="product-tag">
                          {BigInt(p.available_units) > 0n ? 'DISPONIBLE' : 'SIN STOCK'}
                        </span>
                        <span className="product-open">
                          <Plus size={21} />
                        </span>
                      </button>
                      <div className="product-meta">
                        <span>{p.category_name}</span>
                        {p.rating && (
                          <span className="product-rating">
                            <Star size={12} fill="currentColor" />
                            {p.rating} <small>({p.review_count})</small>
                          </span>
                        )}
                      </div>
                      <button className="product-title" onClick={() => setProductId(p.id)}>
                        {p.name}
                      </button>
                      <div className="product-price">
                        <strong>{money(p.price_cents)}</strong>
                        <span>desde</span>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="shop-empty">
                  <Search size={34} />
                  <h3>No encontramos esa combinación.</h3>
                  <p>Probá otra búsqueda o cambiá los filtros.</p>
                  <button className="shop-button dark" onClick={reset}>
                    Ver toda la colección
                  </button>
                </div>
              )}
              {catalog && !loading && (
                <div className="shop-pagination">
                  <span>
                    Página {page} de{' '}
                    {Math.max(1, Math.ceil(Number(catalog.total) / 24)).toLocaleString('es-AR')}
                  </span>
                  <div>
                    <button
                      className="shop-icon"
                      aria-label="Página anterior de tienda"
                      disabled={page <= 1}
                      onClick={() => setPage((p) => p - 1)}
                    >
                      <ArrowLeft />
                    </button>
                    <button
                      className="shop-icon"
                      aria-label="Página siguiente de tienda"
                      disabled={page * 24 >= Number(catalog.total)}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      <ArrowRight />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
        <section className="shop-bottom">
          <div>
            <span className="shop-overline">LO BUENO ESTÁ EN LOS DETALLES</span>
            <h2>
              Menos vueltas.
              <br />
              Más descubrimientos.
            </h2>
          </div>
          <div>
            <p>
              Tu próxima buena elección
              <br />
              puede estar a un clic.
            </p>
            <button
              className="shop-button dark"
              onClick={() => {
                reset();
                scrollCatalog();
              }}
            >
              Seguir explorando <ArrowUpRight size={17} />
            </button>
          </div>
          <Heart className="bottom-heart" strokeWidth={0.7} />
        </section>
      </main>
      <footer className="shop-footer">
        <a className="shop-brand" href="#/shop">
          nexo<span>store</span>
          <i>®</i>
        </a>
        <span>Una tienda para encontrar algo distinto.</span>
        <button className="shop-button outline" onClick={() => void showOrders()}>
          Mis pedidos
        </button>
      </footer>
      {productId && (
        <Modal title="Un nuevo favorito" wide close={() => setProductId(null)}>
          {detailLoading ? (
            <div className="shop-loading">Cargando producto…</div>
          ) : detailError ? (
            <div className="shop-empty" role="alert">
              {detailError}
              <button className="shop-button outline" onClick={() => setRetry((r) => r + 1)}>
                Reintentar
              </button>
            </div>
          ) : (
            product && (
              <>
                <div className="product-detail-layout">
                  <Illustration name={product.name} large />
                  <div className="product-detail-copy">
                    <span className="shop-overline">
                      {product.category_name} / {product.brand_name}
                    </span>
                    <h2>{product.name}</h2>
                    <strong className="detail-price">
                      {money(chosen?.price_cents ?? product.base_price_cents)}
                    </strong>
                    <p className="detail-description">{product.description}</p>
                    <label>
                      Elegí tu variante
                      <select
                        aria-label="Variante del producto"
                        value={variant}
                        onChange={(e) => {
                          setVariant(e.target.value);
                          setQuantity(1);
                        }}
                      >
                        {product.variants.map((v: Row) => (
                          <option value={v.id} key={v.id}>
                            {v.color} · {v.size} — {money(v.price_cents)} ({v.available_units}{' '}
                            disponibles)
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="detail-purchase">
                      <div className="shop-quantity">
                        <button
                          aria-label="Reducir cantidad"
                          disabled={quantity <= 1}
                          onClick={() => setQuantity((q) => q - 1)}
                        >
                          <Minus size={15} />
                        </button>
                        <span>{quantity}</span>
                        <button
                          aria-label="Aumentar cantidad"
                          disabled={
                            !chosen || quantity >= Math.min(Number(chosen.available_units), 1000)
                          }
                          onClick={() => setQuantity((q) => q + 1)}
                        >
                          <Plus size={15} />
                        </button>
                      </div>
                      <button
                        className="shop-button dark"
                        disabled={
                          !cartReady || savingCart || !chosen || BigInt(chosen.available_units) < 1n
                        }
                        onClick={add}
                      >
                        <ShoppingBag size={17} />
                        {chosen && BigInt(chosen.available_units) > 0n
                          ? 'Agregar al carrito'
                          : 'Sin stock'}
                      </button>
                    </div>
                    <small>
                      Vendido por {product.seller_name} · SKU {chosen?.sku ?? '—'}
                    </small>
                  </div>
                </div>
                <div className="product-reviews">
                  <h3>Lo que dicen quienes lo eligieron</h3>
                  {product.reviews.length ? (
                    product.reviews.map((r: Row) => (
                      <div key={r.id}>
                        <strong>
                          {'★'.repeat(Math.max(0, Math.min(5, Number(r.rating))))} · {r.title}
                        </strong>
                        <p>{r.body}</p>
                        <small>{r.author}</small>
                      </div>
                    ))
                  ) : (
                    <p>Todavía no hay reseñas de este producto.</p>
                  )}
                </div>
                {product.related.length > 0 && (
                  <div className="product-related">
                    <h3>Más para descubrir</h3>
                    {product.related.map((r: Row) => (
                      <button key={r.id} onClick={() => setProductId(r.id)}>
                        {r.name}
                        <ArrowUpRight size={15} />
                      </button>
                    ))}
                  </div>
                )}
              </>
            )
          )}
        </Modal>
      )}
      {cartOpen && (
        <Modal title={`Tu carrito (${cartCount})`} close={() => setCartOpen(false)}>
          {cart.length ? (
            <>
              <div className="cart-items">
                {cart.map((i) => (
                  <div className="cart-item" key={i.variant_id}>
                    <button
                      className="cart-image"
                      aria-label={`Ver ${i.name} desde carrito`}
                      onClick={() => {
                        setCartOpen(false);
                        setProductId(i.product_id);
                      }}
                    >
                      <Illustration name={i.name} />
                    </button>
                    <div>
                      <strong>{i.name}</strong>
                      <small>
                        {i.color} · {i.size}
                      </small>
                      <span>{money(i.price_cents)}</span>
                      <div className="shop-quantity">
                        <button
                          aria-label={`Reducir ${i.name}`}
                          disabled={savingCart || i.quantity <= 1}
                          onClick={() =>
                            void saveCart(
                              cart.map((r) =>
                                r.variant_id === i.variant_id
                                  ? { ...r, quantity: r.quantity - 1 }
                                  : r,
                              ),
                            )
                          }
                        >
                          <Minus size={13} />
                        </button>
                        <span>{i.quantity}</span>
                        <button
                          aria-label={`Aumentar ${i.name}`}
                          disabled={savingCart || i.quantity >= Math.min(i.available, 1000)}
                          onClick={() =>
                            void saveCart(
                              cart.map((r) =>
                                r.variant_id === i.variant_id
                                  ? { ...r, quantity: r.quantity + 1 }
                                  : r,
                              ),
                            )
                          }
                        >
                          <Plus size={13} />
                        </button>
                      </div>
                    </div>
                    <button
                      className="shop-icon"
                      aria-label={`Quitar ${i.name}`}
                      disabled={savingCart}
                      onClick={() =>
                        void saveCart(cart.filter((r) => r.variant_id !== i.variant_id))
                      }
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="cart-total">
                <span>Subtotal de productos</span>
                <strong>{money(total.toString())}</strong>
              </div>
              <p className="checkout-note">
                La confirmación verifica precios y disponibilidad actuales.
              </p>
              <button
                className="shop-button dark full"
                disabled={savingCart || !cartReady}
                onClick={beginCheckout}
              >
                Continuar al pedido <ArrowRight size={17} />
              </button>
            </>
          ) : (
            <div className="shop-empty">
              <ShoppingBag size={38} />
              <h3>Hay lugar para algo nuevo.</h3>
              <p>Agregá tu próximo favorito.</p>
              <button
                className="shop-button dark"
                onClick={() => {
                  setCartOpen(false);
                  scrollCatalog();
                }}
              >
                Explorar productos
              </button>
            </div>
          )}
        </Modal>
      )}
      {checkout && (
        <Modal
          title={order ? 'Pedido creado' : 'Confirmar pedido'}
          close={() => {
            if (!submitting) {
              requestSequence.current++;
              setCheckout(false);
            }
          }}
        >
          {order ? (
            <div className="order-success">
              <ShieldCheck size={48} />
              <h3>¡Tu pedido está en marcha!</h3>
              <p>
                Número <strong>#{order.id}</strong>
              </p>
              <p>
                Total confirmado: <strong>{money(order.total_cents)}</strong>
              </p>
              <p>Estado: creado. El stock quedó reservado.</p>
              <ul>
                {order.items.map((i: Row) => (
                  <li key={i.variant_id}>
                    {i.quantity} × {i.product_name_snapshot} —{' '}
                    {money((BigInt(i.unit_price_cents) * BigInt(i.quantity)).toString())}
                  </li>
                ))}
              </ul>
              <p className="checkout-note">Pedido de laboratorio. No se realizó ningún cobro.</p>
              <button className="shop-button dark" onClick={() => setCheckout(false)}>
                Seguir explorando
              </button>
            </div>
          ) : (
            <>
              <p className="checkout-note">Compra de prueba con tu cuenta. No se cobra dinero.</p>
              {customerLoading ? (
                <p>Cargando direcciones…</p>
              ) : (
                customer && (
                  <div className="checkout-customer">
                    <strong>{customer.full_name}</strong>
                    <span>{customer.email}</span>
                    <label>
                      Enviar a
                      <select
                        aria-label="Dirección de entrega"
                        value={address}
                        disabled={submitting}
                        onChange={(e) => setAddress(e.target.value)}
                      >
                        {customer.addresses.map((a: Row) => (
                          <option key={a.id} value={a.id}>
                            {a.street}, {a.city}, {a.country}
                          </option>
                        ))}
                      </select>
                    </label>
                    <AddressForm empty={!customer.addresses.length} onSaved={loadCustomer} />
                  </div>
                )
              )}
              <div className="cart-total">
                <span>Subtotal estimado</span>
                <strong>{money(total.toString())}</strong>
              </div>
              {checkoutError && (
                <p className="shop-error" role="alert">
                  {checkoutError}
                </p>
              )}
              <button
                className="shop-button dark full"
                disabled={
                  submitting ||
                  savingCart ||
                  customerLoading ||
                  !customer ||
                  !address ||
                  !cart.length
                }
                onClick={() => void buy()}
              >
                {submitting ? 'Reservando stock…' : 'Confirmar pedido'}
                <ArrowRight size={17} />
              </button>
            </>
          )}
        </Modal>
      )}
      {ordersOpen && (
        <Modal
          title={selectedOrder ? `Pedido #${selectedOrder.id}` : 'Mis pedidos'}
          close={() => setOrdersOpen(false)}
        >
          {ordersError && (
            <p role="alert" className="shop-error">
              {ordersError}
            </p>
          )}
          {ordersLoading ? (
            <div className="shop-loading">Cargando pedidos…</div>
          ) : selectedOrder ? (
            <div className="order-success">
              <Package size={36} />
              <h3>Pedido #{selectedOrder.id}</h3>
              <p>
                Estado:{' '}
                {selectedOrder.status === 'created'
                  ? 'Creado, stock reservado'
                  : selectedOrder.status}
              </p>
              <p>
                Total: <strong>{money(selectedOrder.total_cents)}</strong>
              </p>
              <ul>
                {selectedOrder.items.map((i: Row) => (
                  <li key={i.variant_id}>
                    {i.quantity} × {i.product_name_snapshot} —{' '}
                    {money((BigInt(i.unit_price_cents) * BigInt(i.quantity)).toString())}
                  </li>
                ))}
              </ul>
              {selectedOrder.address && (
                <p>
                  Entrega: {selectedOrder.address.street}, {selectedOrder.address.city}
                </p>
              )}
              <p className="checkout-note">Compra de laboratorio. Sin cobro.</p>
              <button className="shop-button outline" onClick={() => setSelectedOrder(null)}>
                Volver a mis pedidos
              </button>
            </div>
          ) : (
            <div className="order-list">
              {orders.length ? (
                orders.map((o) => (
                  <button className="order-row" key={o.id} onClick={() => void showOrder(o.id)}>
                    <strong>#{o.id}</strong>
                    <span>
                      {new Date(o.created_at).toLocaleDateString('es-AR')} ·{' '}
                      {o.status === 'created' ? 'Creado' : o.status}
                    </span>
                    <b>{money(o.total_cents)}</b>
                    <ArrowRight size={16} />
                  </button>
                ))
              ) : (
                <p>Todavía no tenés pedidos.</p>
              )}
              {nextOrder && (
                <button className="shop-button outline" onClick={() => void showOrders(nextOrder)}>
                  Ver más pedidos
                </button>
              )}
            </div>
          )}
        </Modal>
      )}
      {notice && (
        <div className="shop-notice" role="status">
          {notice}
          <button aria-label="Cerrar aviso" onClick={() => setNotice('')}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
