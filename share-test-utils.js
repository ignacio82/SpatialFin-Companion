function parseSmbClientListing(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return null;

      const pipeParts = trimmed.split('|');
      if (pipeParts.length >= 2) {
        if (/^[DAF]$/.test(pipeParts[0])) return pipeParts[1];
        if (/^[DAF]$/.test(pipeParts[1])) return pipeParts[0];
      }

      const classicMatch = trimmed.match(/^(.+?)\s{2,}([A-Z]+)\s+\d+\s+/);
      if (!classicMatch) return null;
      if (!/[DA]/.test(classicMatch[2])) return null;
      return classicMatch[1];
    })
    .filter((name) => name && name !== '.' && name !== '..');
}

module.exports = {
  parseSmbClientListing
};
