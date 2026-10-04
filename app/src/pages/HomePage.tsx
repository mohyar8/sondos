import { useRef } from 'react'
import type { NavigationHandler } from '../layout/navigation'
import { useReveal } from '../layout/useReveal'
import BookingStepsSection from './home/BookingStepsSection'
import DifferenceSection from './home/DifferenceSection'
import FaqSection from './home/FaqSection'
import FeaturedWorkSection from './home/FeaturedWorkSection'
import HeroSection from './home/HeroSection'
import ServicesTicker from './home/ServicesTicker'
import ServicesSection from './home/ServicesSection'
import StorySection from './home/StorySection'
import TrustSection from './home/TrustSection'
import ContactSection from './sections/ContactSection'
import './HomePage.css'

interface HomePageProps {
  onNavigate: NavigationHandler
}

/**
 * `/` (design-system §5.2, copy 08-copy-ar §1). Stays in the entry chunk: it
 * is the landing page and the largest-paint route. There is deliberately no
 * testimonials section (decisions.md D7: nothing until the owner supplies
 * real quotes).
 */
export default function HomePage({ onNavigate }: HomePageProps) {
  const mainRef = useRef<HTMLElement>(null)

  useReveal(mainRef)

  return (
    <main id="main-content" className="home" ref={mainRef}>
      <HeroSection onNavigate={onNavigate} />
      <ServicesTicker />
      <StorySection />
      <DifferenceSection />
      <FeaturedWorkSection onNavigate={onNavigate} />
      <ServicesSection onNavigate={onNavigate} />
      <BookingStepsSection onNavigate={onNavigate} />
      <TrustSection />
      <FaqSection onNavigate={onNavigate} />
      <ContactSection onNavigate={onNavigate} />
    </main>
  )
}
