// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        // Primary Government Colors - Indian Flag Inspired
        'gov-primary': '#FF9933',   // Deep Saffron - Courage & Strength
        'gov-secondary': '#138808', // India Green - Growth & Safety
        'gov-accent': '#000080',    // Navy Blue - Authority & Trust
        
        // Emergency & Alert Colors
        'gov-alert': '#DC143C',     // Crimson Red - Critical Alerts Only
        'gov-warning': '#F39C12',   // Warning Orange - Medium Risk
        'gov-safe': '#27AE60',       // Safe Green - Recovery Status
        
        // Neutral Background Colors
        'gov-neutral': '#F5F5DC',   // Warm Sand - Primary Background
        'gov-gray': '#B2BEB5',      // Ash Gray - Secondary Panels
        'gov-dark': '#333333',      // Charcoal Black - Primary Text
        'gov-white': '#FFFFFF',     // Pure White - Text on Dark
        
        // Cultural Accent Colors
        'gov-yellow': '#FFD700',    // Marigold - Cultural Highlights
        'gov-peacock': '#1A4E8A',   // Peacock Blue - Traditional Motifs
        'gov-cream': '#FFF8DC',     // Cream - Soft Backgrounds
        
        // Extended Palette for UI Components
        'gov-primary-light': '#FFB366',  // Light Saffron
        'gov-primary-dark': '#E67A00',   // Dark Saffron
        'gov-secondary-light': '#1FA008', // Light Green
        'gov-secondary-dark': '#0F6604',  // Dark Green
        'gov-accent-light': '#1A4DCC',    // Light Navy
        'gov-accent-dark': '#000066',     // Dark Navy
      },
      
      fontFamily: {
        'hindi': ['Tiro Devanagari Hindi', 'serif'],
        'display': ['Baloo Bhai 2', 'cursive'],
        'heading': ['Rajdhani', 'sans-serif'],
        'body': ['Merriweather', 'serif'],
        'gov': ['Rajdhani', 'sans-serif'],
      },
      
      fontSize: {
        'gov-h1': ['3.5rem', { lineHeight: '1.2', fontWeight: '800' }],
        'gov-h2': ['3rem', { lineHeight: '1.3', fontWeight: '700' }],
        'gov-h3': ['2.5rem', { lineHeight: '1.3', fontWeight: '600' }],
        'gov-h4': ['2rem', { lineHeight: '1.4', fontWeight: '600' }],
        'gov-body': ['1.125rem', { lineHeight: '1.8', fontWeight: '400' }],
        'gov-small': ['0.875rem', { lineHeight: '1.6', fontWeight: '400' }],
      },
      
      spacing: {
        'gov-header': '8px',
        'gov-section': '5rem',
        'gov-container': '1400px',
      },
      
      borderRadius: {
        'gov-card': '1.25rem',
        'gov-button': '3rem',
        'gov-panel': '0.75rem',
      },
      
      boxShadow: {
        'gov-card': '0 10px 40px rgba(0, 0, 0, 0.1)',
        'gov-header': '0 4px 20px rgba(0, 0, 0, 0.3)',
        'gov-button': '0 6px 20px rgba(0, 0, 0, 0.2)',
        'gov-emergency': '0 10px 40px rgba(220, 20, 60, 0.5)',
        'gov-gold': '0 6px 20px rgba(255, 215, 0, 0.4)',
      },
      
      animation: {
        'pulse-gold': 'pulseGold 3s ease-in-out infinite',
        'float': 'float 20s ease-in-out infinite',
        'slide-right': 'slideInRight 0.8s ease-out',
        'emergency-pulse': 'emergencyPulse 2s ease-in-out infinite',
        'rotate-chakra': 'rotateChakra 60s linear infinite',
      },
      
      keyframes: {
        pulseGold: {
          '0%, 100%': { transform: 'scale(1)', boxShadow: '0 6px 20px rgba(255, 215, 0, 0.4)' },
          '50%': { transform: 'scale(1.05)', boxShadow: '0 8px 30px rgba(255, 215, 0, 0.6)' },
        },
        float: {
          '0%, 100%': { transform: 'translate(0, 0) rotate(0deg)' },
          '50%': { transform: 'translate(-50px, 50px) rotate(180deg)' },
        },
        slideInRight: {
          '0%': { opacity: '0', transform: 'translateX(50px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        emergencyPulse: {
          '0%, 100%': { boxShadow: '0 10px 40px rgba(220, 20, 60, 0.5)' },
          '50%': { boxShadow: '0 15px 60px rgba(220, 20, 60, 0.8)' },
        },
        rotateChakra: {
          '0%': { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' },
        },
      },
      
      backgroundImage: {
        'gov-gradient-primary': 'linear-gradient(135deg, #FF9933 0%, #FFB366 100%)',
        'gov-gradient-secondary': 'linear-gradient(135deg, #138808 0%, #1FA008 100%)',
        'gov-gradient-accent': 'linear-gradient(135deg, #000080 0%, #1A4DCC 100%)',
        'gov-gradient-alert': 'linear-gradient(135deg, #DC143C 0%, #FF1744 100%)',
        'gov-gradient-neutral': 'linear-gradient(135deg, #F5F5DC 0%, #FFF8DC 50%, #F5F5DC 100%)',
        'gov-gradient-header': 'linear-gradient(180deg, #FF9933 0%, #FF9933 33.33%, #FFFFFF 33.33%, #FFFFFF 66.66%, #138808 66.66%, #138808 100%)',
        'gov-chakra-pattern': 'radial-gradient(circle at 20% 30%, rgba(255, 153, 51, 0.03) 0%, transparent 50%), radial-gradient(circle at 80% 70%, rgba(19, 136, 8, 0.03) 0%, transparent 50%), radial-gradient(circle at 50% 50%, rgba(0, 0, 128, 0.02) 0%, transparent 50%)',
      },
      
      backdropBlur: {
        'gov': '10px',
      },
    },
  },
  plugins: [],
}

// Semantic Class Usage Examples:
// 
// Headers: bg-gov-primary, text-gov-white
// Safe Status: bg-gov-safe, text-gov-white  
// Alerts: bg-gov-alert, text-gov-white
// Information: bg-gov-accent, text-gov-white
// Backgrounds: bg-gov-neutral, bg-gov-gray
// Text: text-gov-dark, text-gov-white
// Buttons: bg-gov-gradient-primary, bg-gov-gradient-secondary
// Cards: bg-gov-white, shadow-gov-card, rounded-gov-card
