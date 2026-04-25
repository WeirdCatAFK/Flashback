export const connectionTypes = [
  { name: "connection", is_directed: "false" },
  { name: "disconnection", is_directed: "false" },
  { name: "inheritance", is_directed: "true" },
  { name: "tag", is_directed: "false" },
  { name: "reference", is_directed: "true" },
];

export const nodeTypes = [
  "Flashcard",
  "Folder",
  "Document",
  "Tag",
];

export const pedagogicalCategories = [
  { name: "Definition", priority: 0, description: "The definition of a word or concept" },
  { name: "Terminology", priority: 0, description: "The usage of a word" },
  { name: "Symbol", priority: 0, description: "The usage of symbols" },
  { name: "Concept", priority: 1, description: "An abstract idea" },
  { name: "Example", priority: 1, description: "Examples of usage" },
  { name: "Exercise", priority: 2, description: "Apply knowledge in a practical task or problem" },
  { name: "Procedure", priority: 2, description: "Execute a method or algorithm step by step" },
];
