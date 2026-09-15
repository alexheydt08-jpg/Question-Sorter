/* ==========================================================================
   The order the NESA Stage 6 syllabuses (2017) set out modules and inquiry
   questions in. The taxonomy is otherwise built from whichever question
   happened to be tagged first, which put Module 5 Chemistry in the order
   Solution Equilibria → Factors → Static and Dynamic → Keq. Teaching order
   matters when you are revising, so it is pinned here.

   Topic names must match the strings in data.js / trials.js exactly.
   ========================================================================== */
"use strict";

const SYLLABUS = {
  Chemistry: {
    "Module 5: Equilibrium and Acid Reactions": [
      "Static and Dynamic Equilibrium",
      "Factors that Affect Equilibrium",
      "Calculating the Equilibrium Constant (Keq)",
      "Solution Equilibria",
    ],
    "Module 6: Acid/Base Reactions": [
      "Properties of Acids and Bases",
      "Using Brønsted–Lowry Theory",
      "Quantitative Analysis",
    ],
    "Module 7: Organic Chemistry": [
      "Nomenclature",
      "Hydrocarbons",
      "Products of Reactions Involving Hydrocarbons",
      "Alcohols",
      "Reactions of Organic Acids and Bases",
      "Polymers",
    ],
    "Module 8: Applying Chemical Ideas": [
      "Analysis of Inorganic Substances",
      "Analysis of Organic Substances",
      "Chemical Synthesis and Design",
    ],
  },
  /* Economics runs four HSC topics rather than modules 5-8, each a quarter of
     the course, and the order below is the syllabus's own (10.1 to 10.4). The
     sub-topics are the "Students learn about" headings, which is the level a
     past question can actually be filed at. */
  Economics: {
    "Topic 1: The Global Economy": [
      "International Economic Integration",
      "Trade, Financial Flows and Foreign Investment",
      "Globalisation and Economic Development",
    ],
    "Topic 2: Australia's Place in the Global Economy": [
      "Australia's Trade and Financial Flows",
      "Australia's Balance of Payments",
      "Exchange Rates",
      "Free Trade and Protection",
    ],
    "Topic 3: Economic Issues": [
      "Economic Growth",
      "Unemployment",
      "Inflation",
      "External Stability",
      "Distribution of Income and Wealth",
      "Environmental Sustainability",
    ],
    "Topic 4: Economic Policies and Management": [
      "Economic Objectives",
      "Fiscal Policy",
      "Monetary Policy",
      "Microeconomic Policies",
      "Labour Market Policies",
      "Environmental Management",
      "Limitations of Economic Policies",
    ],
  },

  Physics: {
    "Module 5: Advanced Mechanics": [
      "Projectile Motion",
      "Circular Motion",
      "Motion in Gravitational Fields",
    ],
    "Module 6: Electromagnetism": [
      "Charged Particles, Conductors and Electric and Magnetic Fields",
      "The Motor Effect",
      "Electromagnetic Induction",
      "Applications of the Motor Effect",
    ],
    "Module 7: The Nature of Light": [
      "Electromagnetic Spectrum",
      "Light: Wave Model",
      "Light: Quantum Model",
      "Light and Special Relativity",
    ],
    "Module 8: From the Universe to the Atom": [
      "Origins of the Elements",
      "Structure of the Atom",
      "Quantum Mechanical Nature of the Atom",
      "Properties of the Nucleus",
      "Deep Inside the Atom",
    ],
  },
};

/* position of a topic within its module, or a large number so anything the
   syllabus does not name (the catch-all bucket) sorts to the end */
function topicOrder(subject, module, topic){
  const list = (SYLLABUS[subject] || {})[module];
  const i = list ? list.indexOf(topic) : -1;
  return i === -1 ? 99 : i;
}
