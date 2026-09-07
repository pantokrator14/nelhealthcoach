import { useState } from 'react'
import { useRouter } from 'next/router'
import Link from 'next/link'
import Head from 'next/head'
import Image from 'next/image'
import { apiClient } from '@/lib/api';
import { setAuthToken } from '@/lib/authSession';
import PasswordInput from '@/components/PasswordInput';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from 'react-i18next';

export default function Login() {
  const { showToast, ToastComponent } = useToast();
  const { t } = useTranslation();
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const result = await apiClient.login({ email, password });

      setAuthToken(result.token);
      router.push('/dashboard');
    } catch (err: unknown) {
      // Mostrar el mensaje real del backend (ej. "Debes verificar tu email antes de iniciar sesión")
      const message = err instanceof Error ? err.message : 'Error de conexión. Intenta nuevamente.';

      // SEC-13: si el backend devuelve 503 (fail-closed — MongoDB no disponible),
      // mostrar el mensaje traducido (i18n) y avisar con toast de warning para que
      // el usuario sepa que es un problema temporal del servicio, no de sus credenciales.
      if (message.includes('temporalmente no disponible')) {
        setError(t('register.errors.serviceUnavailable'));
        showToast(t('register.errors.serviceUnavailable'), 'warning');
      } else {
        setError(message);
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Head>
        <title>Iniciar Sesión - NELHEALTHCOACH</title>
      </Head>
      
      <div className="min-h-screen bg-gradient-to-br from-blue-400 via-blue-500 to-blue-600 flex items-center justify-center p-4">
        
        {/* Tarjeta con diseño moderno */}
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden border border-white/20">
          
          {/* Encabezado */}
          <div className=" p-8 flex justify-center">
            <div className="relative w-48 h-16">
              <Image
                src="/logo2.png"
                alt="NELHEALTHCOACH Logo"
                fill
                sizes="192px"
                style={{ objectFit: 'contain' }}
                priority
              />
            </div>
          </div>

          {/* Formulario */}
          <div className="p-8">
            <div className="flex items-center justify-center mb-6">
              <div className="w-12 h-12 bg-blue-600 rounded-full flex items-center justify-center mr-3">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <h1 className="text-2xl font-bold text-blue-700">
                Iniciar Sesión
              </h1>
            </div>
            
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-2 flex items-center">
                  <svg className="w-4 h-4 mr-2 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 12a4 4 0 10-8 0 4 4 0 008 0zm0 0v1.5a2.5 2.5 0 005 0V12a9 9 0 10-9 9m4.5-1.206a8.959 8.959 0 01-4.5 1.207" />
                  </svg>
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-4 py-3 text-gray-700 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition duration-200"
                  required
                  placeholder="Ingresa tu email"
                  disabled={loading}
                />
              </div>

              <div>
                <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-2 flex items-center">
                  <svg className="w-4 h-4 mr-2 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                  Contraseña
                </label>
                <PasswordInput
                  id="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Ingresa tu contraseña"
                  required
                  disabled={loading}
                  autoComplete="current-password"
                />
              </div>

              {/* Mensaje de error */}
              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                  <div className="flex items-center">
                    <svg className="w-4 h-4 mr-2 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    {error}
                  </div>
                  {error.toLowerCase().includes('verificar') && (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          setLoading(true);
                          await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/auth/resend-verification`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ email }),
                          });
                          setError('');
                          showToast(t('auth.resendVerificationSent'), 'success');
                        } catch {
                          showToast(t('auth.resendVerificationFailed'), 'error');
                        } finally {
                          setLoading(false);
                        }
                      }}
                      className="mt-2 text-blue-600 hover:text-blue-800 underline font-medium"
                    >
                      📧 Reenviar enlace de verificación
                    </button>
                  )}
                </div>
              )}

              {/* Botón de login */}
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-blue-600 text-white py-3 px-4 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition duration-200 disabled:opacity-50 disabled:cursor-not-allowed font-medium flex items-center justify-center"
              >
                {loading ? (
                  <span className="flex items-center justify-center">
                    <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Iniciando sesión...
                  </span>
                ) : (
                  <>
                    <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                    </svg>
                    Iniciar Sesión
                  </>
                )}
              </button>

              {/* Links de navegación */}
              <div className="mt-6 text-center space-y-3">
                <div>
                  <Link
                    href="/forgot-password"
                    className="text-sm text-blue-600 hover:text-blue-800 transition duration-200"
                  >
                    ¿Olvidaste tu contraseña?
                  </Link>
                </div>
                <div className="border-t border-gray-200 pt-4">
                  <p className="text-sm text-gray-700 mb-2">¿Aún no tienes cuenta?</p>
                  <Link
                    href="/register"
                    className="inline-flex items-center gap-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 px-5 py-2.5 rounded-lg transition duration-200 shadow-md hover:shadow-lg"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Prueba gratis 30 días
                  </Link>
                  <p className="text-xs text-gray-400 mt-2">
                    Sin costo ahora. $1 reembolsable para verificar tu tarjeta.
                  </p>
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>
      <ToastComponent />
    </>
  )
}