import { FakeFileSystem } from '../fake-file-system.ts'
import { runFileSystemConformance } from './file-system.ts'

runFileSystemConformance('FakeFileSystem', () => {
  const fake = new FakeFileSystem(['/work'])
  return {
    fs: fake,
    inside: (rel) => `/work/${rel}`,
    outside: (rel) => `/elsewhere/${rel}`,
    put: async (path, content) => fake.setFile(path, content),
  }
})
