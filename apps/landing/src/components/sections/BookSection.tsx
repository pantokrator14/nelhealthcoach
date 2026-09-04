import React from 'react';
import Image from 'next/image';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';

const BookSection: React.FC = () => {
  const { t } = useTranslation();

  return (
    <section id="libro" className="bg-white py-16 md:py-24 px-4 relative overflow-hidden">
      {/* Decoración sutil de fondo */}
      <div
        aria-hidden="true"
        className="absolute -top-24 -left-24 w-72 h-72 bg-blue-100 rounded-full opacity-50 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="absolute -bottom-24 -right-24 w-80 h-80 bg-sky-100 rounded-full opacity-50 blur-3xl"
      />

      <div className="container mx-auto max-w-6xl relative">
        <div className="flex flex-col lg:flex-row items-center gap-12 lg:gap-16">
          {/* Columna de texto */}
          <div className="w-full lg:w-[55%] text-center lg:text-left order-2 lg:order-1">
            <span className="inline-block bg-blue-50 text-blue-600 text-xs font-bold uppercase tracking-widest border border-blue-100 rounded-full px-4 py-1.5 mb-5">
              {t('landing.book.eyebrow')}
            </span>

            <h2 className="text-4xl md:text-5xl font-extrabold text-blue-900 leading-tight mb-1">
              {t('landing.book.title')}
            </h2>
            <p className="text-2xl md:text-3xl font-light italic text-blue-500 mb-2">
              {t('landing.book.subtitle')}
            </p>
            <p className="text-sm font-semibold text-gray-500 uppercase tracking-widest mb-7">
              {t('landing.book.author')}
            </p>

            <p className="text-lg leading-relaxed text-gray-600 mb-4">
              {t('landing.book.description1')}
            </p>
            <p className="text-lg leading-relaxed text-gray-600 mb-9">
              {t('landing.book.description2')}
            </p>

            {/* Botones de compra */}
            <div className="flex flex-col sm:flex-row items-center justify-center lg:justify-start gap-4 mb-9">
              <a
                href="#"
                className="inline-flex items-center justify-center gap-3 w-full sm:w-auto px-8 py-4 bg-gradient-to-r from-blue-600 to-blue-800 text-white font-bold text-lg rounded-xl shadow-xl hover:shadow-2xl hover:scale-[1.03] active:scale-95 transition-all"
              >
                <svg
                  className="w-5 h-5 flex-shrink-0"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 0 0-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 0 0-16.536-1.84M7.5 14.25 5.106 5.272M6 20.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm12.75 0a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z"
                  />
                </svg>
                {t('landing.book.ctaAmazon')}
              </a>

              <a
                href="#"
                className="inline-flex items-center justify-center w-full sm:w-auto px-8 py-4 border-2 border-blue-600 text-blue-700 font-bold text-lg rounded-xl hover:bg-blue-50 transition-colors"
              >
                {t('landing.book.ctaOther')}
              </a>
            </div>

            {/* Oferta */}
            <div className="bg-blue-50 border border-blue-100 rounded-2xl p-5 md:p-6 text-left flex items-start gap-4 max-w-xl mx-auto lg:mx-0">
              <div className="flex-shrink-0 bg-blue-600 rounded-full p-2.5 text-white">
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M21 11.25v8.25a1.5 1.5 0 0 1-1.5 1.5H4.5A1.5 1.5 0 0 1 3 19.5v-8.25M12 4.875A2.625 2.625 0 1 0 9.375 7.5H12m0-2.625V7.5m0-2.625A2.625 2.625 0 1 1 14.625 7.5H12m0 0V21m-8.25-9.75h16.5m-16.5 0a1.5 1.5 0 0 1-1.5-1.5V7.5a1.5 1.5 0 0 1 1.5-1.5h3a1.5 1.5 0 0 1 1.5 1.5v1.5m-4.5 0h4.5m-9 0h16.5"
                  />
                </svg>
              </div>
              <div>
                <p className="font-bold text-blue-900">{t('landing.book.offerTitle')}</p>
                <p className="text-blue-900/70 text-sm md:text-base mt-1">
                  {t('landing.book.offerText')}
                </p>
              </div>
            </div>
          </div>

          {/* Portada del libro (alineada a la derecha en desktop) */}
          <div className="w-full lg:w-[45%] flex justify-center order-1 lg:order-2">
            <div className="relative">
              <div
                aria-hidden="true"
                className="absolute -inset-6 bg-gradient-to-tr from-blue-200 via-sky-100 to-transparent rounded-[2rem] rotate-3 blur-sm"
              />
              <div className="relative w-64 sm:w-80 lg:w-[22rem] rounded-2xl overflow-hidden shadow-2xl ring-1 ring-blue-900/10 rotate-1 hover:rotate-0 hover:scale-[1.02] transition-transform duration-500">
                <div className="relative aspect-[3/4] w-full">
                  <Image
                    src="/images/libro.png"
                    alt={t('landing.book.alt')}
                    fill
                    sizes="(max-width: 640px) 16rem, (max-width: 1024px) 20rem, 22rem"
                    priority
                    className="object-cover"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default BookSection;
