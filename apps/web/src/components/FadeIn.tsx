import React from 'react';
import { useFadeIn, useStaggerChildren } from '../hooks/useAnimations';

export function FadeIn({ children, delay = 0, className = '' }: { children: React.ReactNode; delay?: number; className?: string }) {
  const fade = useFadeIn();
  return (
    <div ref={fade.ref} className={`${fade.className} ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

export function StaggerContainer({ children, className = '', staggerMs = 100 }: { children: React.ReactNode; className?: string; staggerMs?: number }) {
  const { ref, visible } = useStaggerChildren();
  return (
    <div ref={ref} className={className}>
      {React.Children.map(children, (child, i) => (
        <div
          className={`transition-all duration-600 ease-out ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'}`}
          style={{ transitionDelay: visible ? `${i * staggerMs}ms` : '0ms' }}
        >
          {child}
        </div>
      ))}
    </div>
  );
}
