// The words and names that must not appear in tracked public files (the repository is English only).
// Tests that guard against them import these lists, so the words live in exactly one place.

// Names tied to one country or deployment.
export const COUNTRY_RE = /Indonesia|Bahasa|\bWIB\b|Jakarta|Yogyakarta|\bRp\b|\bIDR\b/;

export const COUNTRY_NAMES = ['Indonesia', 'Indonesian', 'Bahasa'];

// Long, unambiguous words: safe to scan every tracked file for. Short words that are also English or
// common identifiers are deliberately left out.
export const REPO_WORDS = ['mingguan', 'bulanan', 'rupiah', 'berita', 'kirimkan', 'simpan', 'hapus', 'jangan', 'ringkas', 'terjemahkan', 'terjemahan',
  'judul', 'kenapa', 'topik', 'substansi', 'istilah', 'adalah', 'dengan', 'untuk', 'tidak', 'sudah', 'belum', 'harus', 'karena', 'tetapi',
  'sebagai', 'percakapan', 'lampiran', 'disimpan', 'pengguna', 'tampilkan', 'berhasil', 'mohon', 'dirilis', 'pengaturan', 'sebuah'];
export const REPO_WORDS_RE = new RegExp(`(?<![A-Za-z])(?:${REPO_WORDS.join('|')})(?![A-Za-z])`, 'i');

// The wider list used for UI files, where false positives are easy to review.
export const UI_WORDS_RE = /(?<!\w)(?:tutup|simpan|batal|hapus|kirim|masuk|keluar|gagal|berhasil|sedang|belum|sudah|tidak|tekan|pilih|cari|memuat|aku|kamu|untuk|dengan|dari|yang|atau|juga|lebih|kurang|hari|jam|menit|detik|pesan|balasan|batas|kuota|sumber|cerita|akun|sandi|suara|notifikasi|pengaturan|tampilan|anggaran|catatan|fakta|selera|urutan|kategori|istilah|mesin|penulis|baru|lama|kecil|besar|terang|gelap|sistem|otomatis|semua|lainnya|salin|unduh|buka|lihat|tambah|ubah|ganti|judul|kolom|gambar|foto|kamera|perangkat|tanggal|bulan|tahun|minggu|kemarin|sekarang|sebentar|saja|mau|ingin|harus|perlu|dapat|adalah|oleh|pada|dalam|atas|bawah|sana|apa|siapa|kapan|bagaimana|kenapa|berapa)(?!\w)/i;
