import { useState, type FormEvent } from 'react';
import { api } from './data';

export default function AddressForm({
  empty,
  onSaved,
}: {
  empty: boolean;
  onSaved: () => Promise<void>;
}) {
  const [street, setStreet] = useState('');
  const [city, setCity] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [country, setCountry] = useState('AR');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/store/customer/addresses', {
        method: 'POST',
        body: JSON.stringify({ street, city, postal_code: postalCode, country }),
      });
      await onSaved();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="address-form" open={empty}>
      <summary>{empty ? 'Agregá tu dirección de entrega' : 'Agregar otra dirección'}</summary>
      <form onSubmit={(event) => void save(event)}>
        <label>
          Calle y número
          <input
            autoComplete="street-address"
            value={street}
            onChange={(event) => setStreet(event.target.value)}
            required
            maxLength={200}
            disabled={busy}
          />
        </label>
        <label>
          Ciudad
          <input
            autoComplete="address-level2"
            value={city}
            onChange={(event) => setCity(event.target.value)}
            required
            maxLength={100}
            disabled={busy}
          />
        </label>
        <label>
          Código postal
          <input
            autoComplete="postal-code"
            value={postalCode}
            onChange={(event) => setPostalCode(event.target.value)}
            required
            maxLength={20}
            disabled={busy}
          />
        </label>
        <label>
          País (AR, UY, etc.)
          <input
            autoComplete="country"
            value={country}
            onChange={(event) => setCountry(event.target.value.toUpperCase())}
            required
            pattern="[A-Z]{2}"
            maxLength={2}
            disabled={busy}
          />
        </label>
        {error && (
          <p className="shop-error" role="alert">
            {error}
          </p>
        )}
        <button className="shop-button dark" disabled={busy}>
          {busy ? 'Guardando…' : 'Guardar dirección'}
        </button>
      </form>
    </details>
  );
}
