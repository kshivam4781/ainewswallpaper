'use strict';

/**
 * Colors are ARGB hex strings (System.Drawing.ColorTranslator.FromHtml friendly
 * once we prefix '#'; alpha is applied separately where noted).
 */
const THEMES = {
  midnight: {
    bgTop: '#0A0E1A',
    bgBottom: '#141F38',
    glow: '#1E3A6E',
    accent: '#4C8DFF',
    accentSoft: '#7FB0FF',
    title: '#F2F6FF',
    body: '#E4EAF6',
    muted: '#7E8CA8',
    rule: '#243350',
    dot: '#1B2740'
  },
  carbon: {
    bgTop: '#0B0B0C',
    bgBottom: '#1A1614',
    glow: '#3A2412',
    accent: '#FF8A3D',
    accentSoft: '#FFB27A',
    title: '#FAF7F4',
    body: '#EDE7E1',
    muted: '#8C837B',
    rule: '#2E2A26',
    dot: '#211D1A'
  },
  slate: {
    bgTop: '#101418',
    bgBottom: '#1D262C',
    glow: '#1F3A38',
    accent: '#3FD3B4',
    accentSoft: '#8AE8D5',
    title: '#F4F8F8',
    body: '#E2EAEA',
    muted: '#7C8B8E',
    rule: '#26333A',
    dot: '#1A2429'
  },
  daylight: {
    bgTop: '#F7F9FC',
    bgBottom: '#E4EAF3',
    glow: '#CBD9F0',
    accent: '#2563EB',
    accentSoft: '#5B8DEF',
    title: '#0F172A',
    body: '#1E293B',
    muted: '#64748B',
    rule: '#CBD5E1',
    dot: '#DCE4F0'
  }
};

function getTheme(name) {
  return THEMES[name] || THEMES.midnight;
}

module.exports = { THEMES, getTheme, themeNames: Object.keys(THEMES) };
