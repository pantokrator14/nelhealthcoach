import React, { useState, useEffect, useRef } from 'react';
import Image from 'next/image';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';

const Navbar: React.FC = () => {
  const { t } = useTranslation();
  const [isScrolled, setIsScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isOverHero, setIsOverHero] = useState(true);
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Efecto para detectar scroll y cambiar estilo de sombra
  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 10);
    };
    
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Efecto para detectar cuándo estamos sobre la sección hero (carrusel)
  useEffect(() => {
    const heroSection = document.getElementById('inicio');
    if (!heroSection) return;

    observerRef.current = new IntersectionObserver(
      ([entry]) => {
        // isOverHero será true cuando el hero esté visible en el viewport
        setIsOverHero(entry.isIntersecting);
      },
      {
        threshold: 0.1, // Se activa cuando al menos el 10% del hero es visible
        rootMargin: '-80px 0px 0px 0px' // Compensa la altura del navbar fijo
      }
    );

    observerRef.current.observe(heroSection);

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, []);

  // Elementos del menú de navegación
  const navItems = [
    { id: 'inicio', labelKey: 'landing.nav.inicio' },
    { id: 'metodo', labelKey: 'landing.nav.metodo' },
    { id: 'sobre-mi', labelKey: 'landing.nav.sobreMi' },
    { id: 'libro', labelKey: 'landing.nav.libro' },
    // { id: 'testimonios', labelKey: 'landing.nav.testimonios' },
    { id: 'contacto', labelKey: 'landing.nav.contacto' },
  ];

  // Función para scroll suave con animación
  const scrollToSection = (id: string) => {
    const element = document.getElementById(id);
    if (element) {
      const offset = 80;
      const bodyRect = document.body.getBoundingClientRect().top;
      const elementRect = element.getBoundingClientRect().top;
      const elementPosition = elementRect - bodyRect;
      const offsetPosition = elementPosition - offset;

      window.scrollTo({
        top: offsetPosition,
        behavior: 'smooth'
      });
    }
    setMobileMenuOpen(false);
  };

  // Determinar estilos y logo según la posición
  const navbarBackground = isOverHero 
    ? 'bg-transparent shadow-none' 
    : 'bg-white shadow-md';

  const textColor = isOverHero 
    ? 'text-white hover:text-blue-200' 
    : 'text-gray-700 hover:text-blue-600';

  const logoPath = isOverHero 
    ? '/images/logo1.png'  // Logo blanco para el hero
    : '/images/logo.png';  // Logo azul para el resto

  return (
    <header className={`fixed w-full h-auto z-50 transition-all duration-300 ${navbarBackground} py-2`}>
      <div className="container mx-auto px-4 flex justify-between items-center">
        {/* Logo */}
        <div 
          onClick={() => scrollToSection('inicio')}
          className="cursor-pointer relative"
        >
          <div className="relative h-17 w-60 pt-5">
            <Image
              src={logoPath}
              alt="NELHEALTHCOACH"
              fill
              className="object-contain"
              priority
            />
          </div>
        </div>
        
        {/* Navegación desktop */}
        <nav className="hidden md:flex space-x-8">
          {navItems.map((item) => (
            <a 
              key={item.id} 
              onClick={() => scrollToSection(item.id)}
              className={`font-medium transition-colors cursor-pointer ${textColor}`}
            >
              {t(item.labelKey)}
            </a>
          ))}
        </nav>
        
        {/* Botón de menú móvil */}
        <button 
          className={`md:hidden text-2xl ${isOverHero ? 'text-white' : 'text-gray-700'}`}
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
        >
          {mobileMenuOpen ? '✕' : '☰'}
        </button>
      </div>
      
      {/* Menú móvil */}
      {mobileMenuOpen && (
        <div className={`md:hidden py-4 px-4 transition-all duration-300 ${isOverHero ? 'bg-gray-900/95' : 'bg-white'}`}>
          <div className="flex flex-col space-y-3">
            {navItems.map((item) => (
              <a 
                key={item.id} 
                onClick={() => scrollToSection(item.id)}
                className={`font-medium transition-colors py-2 cursor-pointer ${isOverHero ? 'text-white hover:text-blue-200' : 'text-gray-700 hover:text-blue-600'}`}
              >
                {t(item.labelKey)}
              </a>
            ))}
          </div>
        </div>
      )}
    </header>
  );
};

export default Navbar;