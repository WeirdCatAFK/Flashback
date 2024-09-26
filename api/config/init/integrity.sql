SELECT COUNT(*) FROM sqlite_master 
WHERE type = 'table' 
  AND name IN (
    'Node_types', 'Nodes', 'Folders', 'Documents', 'Flashcard_highlight', 
    'Flashcards', 'Flashcard_info', 'Media_types', 'Media', 'Flashcard_media', 
    'Tags', 'Connection_types', 'Node_connections', 'Inherited_tags', 'Path', 
    'Path_connections'
  );