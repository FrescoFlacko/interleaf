import { describe, expect, test, beforeEach } from 'vitest';
import { InterleafDatabase } from '../../src/main/db/database';
import { runMigrations } from '../../src/main/db/migrations';
import { FolderRepository } from '../../src/main/db/repositories/folder-repository';
import { InterleafError } from '../../src/shared/errors/interleaf-error';

describe('FolderRepository', () => {
  let db: InterleafDatabase;
  let repo: FolderRepository;

  beforeEach(() => {
    db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    repo = new FolderRepository(db);
  });

  test('creates, renames, and lists virtual folders', () => {
    const f1 = repo.create('f1', 'Computer Science');
    expect(f1.name).toBe('Computer Science');
    expect(f1.parentId).toBeNull();

    const f2 = repo.create('f2', 'Distributed Systems', 'f1');
    expect(f2.name).toBe('Distributed Systems');
    expect(f2.parentId).toBe('f1');

    const renamed = repo.rename('f2', 'Distributed & Cloud Systems');
    expect(renamed.name).toBe('Distributed & Cloud Systems');

    const list = repo.list();
    expect(list.length).toBe(2);
    expect(list.find((f) => f.id === 'f1')?.name).toBe('Computer Science');
    expect(list.find((f) => f.id === 'f2')?.name).toBe('Distributed & Cloud Systems');
  });

  test('enforces name validation rules', () => {
    expect(() => {
      repo.create('f-empty', '   ');
    }).toThrow(InterleafError);

    expect(() => {
      repo.create('f-empty', '');
    }).toThrow(InterleafError);

    expect(() => {
      repo.create('f-control', 'Bad\x00Name');
    }).toThrow(InterleafError);

    expect(() => {
      repo.create('f-long', 'A'.repeat(256));
    }).toThrow(InterleafError);

    const valid = repo.create('f-valid', '  Trimmed Name  ');
    expect(valid.name).toBe('Trimmed Name');
  });

  test('rejects case-insensitive duplicate names among siblings', () => {
    repo.create('root-a', 'Research');
    expect(() => repo.create('root-b', ' research ')).toThrow(/already exists/i);

    repo.create('parent-a', 'Parent A');
    repo.create('parent-b', 'Parent B');
    repo.create('child-a', 'Notes', 'parent-a');
    expect(() => repo.create('child-b', 'NOTES', 'parent-a')).toThrow(/already exists/i);
    expect(() => repo.create('child-c', 'Notes', 'parent-b')).not.toThrow();
    expect(() => repo.rename('parent-b', 'RESEARCH')).toThrow(/already exists/i);

    repo.create('unicode-root', 'Résumé');
    expect(() => repo.create('unicode-duplicate', 'RÉSUMÉ')).toThrow(/already exists/i);
    repo.create('street-root', 'Straße');
    expect(() => repo.create('street-duplicate', 'STRASSE')).toThrow(/already exists/i);
    repo.create('ligature-root', 'ﬀ');
    expect(() => repo.create('ligature-duplicate', 'FF')).toThrow(/already exists/i);

    // Greek final sigma folding (ς -> σ)
    repo.create('greek-odysseus-upper', 'ΟΔΥΣΣΕΥΣ');
    expect(() => repo.create('greek-odysseus-final-sigma', 'οδυσσευς')).toThrow(/already exists/i);
    expect(() => repo.create('greek-odysseus-regular-sigma', 'οδυσσευσ')).toThrow(/already exists/i);

    repo.create('greek-sisyphus', 'Σίσυφος');
    expect(() => repo.create('greek-sisyphus-final', 'σίσυφοσ')).toThrow(/already exists/i);

    repo.create('greek-melos', 'μέλος');
    expect(() => repo.create('greek-melos-final', 'μέλοσ')).toThrow(/already exists/i);
  });
  test('deletes folder and cascades to subfolders in database', () => {
    repo.create('parent', 'Parent Folder');
    repo.create('child', 'Child Folder', 'parent');
    repo.create('grandchild', 'Grandchild Folder', 'child');

    expect(repo.list().length).toBe(3);

    repo.delete('parent');

    expect(repo.findById('parent')).toBeNull();
    expect(repo.findById('child')).toBeNull();
    expect(repo.findById('grandchild')).toBeNull();
    expect(repo.list().length).toBe(0);
  });

  test('builds nested folder tree correctly', () => {
    repo.create('root1', 'Programming');
    repo.create('sub1', 'JavaScript', 'root1');
    repo.create('sub2', 'Rust', 'root1');
    repo.create('root2', 'History');

    const tree = repo.getTree();
    expect(tree.length).toBe(2);

    const progRoot = tree.find((t) => t.id === 'root1');
    expect(progRoot).toBeDefined();
    expect(progRoot?.children.length).toBe(2);
    expect(progRoot?.children.map((c) => c.name).sort()).toEqual(['JavaScript', 'Rust']);

    const histRoot = tree.find((t) => t.id === 'root2');
    expect(histRoot?.children.length).toBe(0);
  });

  test('detects and blocks cycle creation in hierarchy', () => {
    repo.create('a', 'Folder A');
    repo.create('b', 'Folder B', 'a');
    repo.create('c', 'Folder C', 'b');

    // Self parent cycle
    expect(() => {
      repo.validateNoCycle('a', 'a');
    }).toThrow(/cannot be its own parent/);

    // Descendant as parent cycle: Moving A into C
    expect(() => {
      repo.validateNoCycle('a', 'c');
    }).toThrow(/descendants/);

    // Moving B into C
    expect(() => {
      repo.validateNoCycle('b', 'c');
    }).toThrow(/descendants/);

    // Valid move: Moving C to root (null) or A to root
    expect(() => {
      repo.validateNoCycle('c', null);
    }).not.toThrow();

    expect(() => {
      repo.validateNoCycle('c', 'a');
    }).not.toThrow();
  });
});
