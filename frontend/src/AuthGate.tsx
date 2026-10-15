import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, LogOut, ShoppingBag } from 'lucide-react';
import { api, ApiError } from './data';
import Shop from './Shop';
import './auth.css';

type Customer = { id: string; full_name: string; email: string };

export default function AuthGate() {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(true);
  const [signup, setSignup] = useState(false);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const expired = () => {
      setCustomer(null);
      setError('Tu sesión venció. Volvé a ingresar.');
    };
    window.addEventListener('nexo:session-expired', expired);
    api<{ data: Customer }>('/auth/session', { signal: controller.signal })
      .then((result) => setCustomer(result.data))
      .catch((failure: Error) => {
        if (
          failure.name !== 'AbortError' &&
          !(failure instanceof ApiError && failure.status === 401)
        ) {
          setError(failure.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
      window.removeEventListener('nexo:session-expired', expired);
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await api<{ data: Customer }>(signup ? '/auth/signup' : '/auth/login', {
        method: 'POST',
        body: JSON.stringify(
          signup ? { full_name: fullName, email, password } : { email, password },
        ),
      });
      setPassword('');
      setCustomer(result.data);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    setError('');
    try {
      await api('/auth/logout', { method: 'POST', body: '{}' });
      setCustomer(null);
      setPassword('');
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="auth-loading" role="status">
        Cargando tu cuenta…
      </div>
    );
  }
  if (customer) {
    return (
      <>
        <div className="account-bar">
          <span>
            Hola, <strong>{customer.full_name}</strong>
          </span>
          <button disabled={busy} onClick={() => void logout()}>
            <LogOut size={15} />
            Cerrar sesión
          </button>
          {error && <span role="alert">{error}</span>}
        </div>
        <Shop key={customer.id} />
      </>
    );
  }
  return (
    <main className="auth-page">
      <section className="auth-intro">
        <a className="auth-brand" href="/">
          nexo<span>store</span>
        </a>
        <ShoppingBag size={76} strokeWidth={1} />
        <h1>
          Tu próximo
          <br /> <em>favorito.</em>
        </h1>
        <p>
          Guardá tu carrito, elegí algo distinto
          <br />y encontrá todos tus pedidos en un lugar.
        </p>
      </section>
      <section
        className="auth-card"
        aria-label={signup ? 'Registro de cuenta' : 'Acceso a tu cuenta'}
      >
        <p className="auth-overline">BIENVENIDO A NEXO STORE</p>
        <h2>{signup ? 'Creá tu cuenta' : 'Iniciá sesión'}</h2>
        <p>
          {signup
            ? 'Un lugar para tus próximas buenas elecciones.'
            : 'Ingresá con tu email y contraseña.'}
        </p>
        <form onSubmit={(event) => void submit(event)}>
          {signup && (
            <label>
              Nombre completo
              <input
                name="full_name"
                autoComplete="name"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                required
                minLength={2}
                maxLength={120}
                disabled={busy}
              />
            </label>
          )}
          <label>
            Email
            <input
              name="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              maxLength={254}
              disabled={busy}
            />
          </label>
          <label>
            Contraseña
            <input
              name="password"
              type="password"
              autoComplete={signup ? 'new-password' : 'current-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={signup ? 12 : 1}
              maxLength={128}
              disabled={busy}
            />
          </label>
          {signup && <small>Usá una contraseña de al menos 12 caracteres.</small>}
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
          <button className="auth-submit" disabled={busy}>
            {busy ? 'Un momento…' : signup ? 'Crear cuenta' : 'Ingresar'}
            <ArrowRight size={18} />
          </button>
        </form>
        <p className="auth-switch">
          {signup ? '¿Ya tenés cuenta?' : '¿Primera vez por acá?'}{' '}
          <button
            disabled={busy}
            onClick={() => {
              setSignup(!signup);
              setError('');
              setPassword('');
            }}
          >
            {signup ? 'Iniciar sesión' : 'Crear cuenta'}
          </button>
        </p>
      </section>
    </main>
  );
}
