import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR, all, get, isSeeded, markSeeded, run, saveNow } from './db.js';
import { hashPassword } from './lib/passwords.js';
import { buildPdf } from './lib/pdfgen.js';
import { buildEpub } from './lib/epubgen.js';

const CLASSES = [
  [1, 'Class 1', 'junior'],
  [2, 'Class 2', 'junior'],
  [3, 'Class 3', 'middle'],
  [4, 'Class 4', 'middle'],
  [5, 'Class 5', 'middle'],
  [6, 'Class 6', 'senior'],
  [7, 'Class 7', 'senior'],
  [8, 'Class 8', 'senior'],
];

const SUBJECTS = [
  ['Mathematics', '📐', '#2f6fd0', 'Numbers, patterns, geometry and problem solving.', [1, 2, 3, 4, 5, 6, 7, 8]],
  ['Science', '🔬', '#0f9d8f', 'Living things, matter, energy and the world around us.', [1, 2, 3, 4, 5, 6, 7, 8]],
  ['English', '📖', '#7b5bd6', 'Reading, writing, grammar and confident communication.', [1, 2, 3, 4, 5, 6, 7, 8]],
  ['Social Studies', '🌍', '#d98324', 'People, places, communities and citizenship.', [1, 2, 3, 4, 5, 6, 7, 8]],
  ['Computer Science', '💻', '#2563eb', 'Computing ideas, coding and digital skills.', [3, 4, 5, 6, 7, 8]],
  ['Technology', '⚙️', '#0f766e', 'Design, engineering and how things are made.', [4, 5, 6, 7, 8]],
  ['General Knowledge', '🧠', '#b45309', 'Wide world facts, quizzes and discovery.', [1, 2, 3, 4, 5]],
  ['Creative Learning', '🎨', '#db2777', 'Art, music, storytelling and imagination.', [1, 2, 3]],
  ['Islamic Studies', '🕌', '#0f6b4f', 'Belief, worship, manners and Islamic history.', [1, 2, 3, 4, 5, 6, 7, 8]],
  ['Quran Studies', '📗', '#15803d', 'Reading, understanding and memorising the Quran.', [1, 2, 3, 4, 5, 6, 7, 8]],
];

const CURRICULUM = {
  Mathematics: [
    ['Numbers and Place Value', ['Reading and writing numbers', 'Comparing and ordering numbers']],
    ['Fractions', ['Equivalent fractions', 'Adding simple fractions']],
  ],
  Science: [
    ['Living Things', ['What living things need', 'Plants and their parts']],
    ['Matter and Materials', ['Solids, liquids and gases', 'Changing states']],
  ],
  English: [
    ['Reading Skills', ['Finding the main idea', 'Using context clues']],
    ['Grammar Basics', ['Nouns, verbs and adjectives', 'Building better sentences']],
  ],
  'Social Studies': [
    ['My Community', ['Family and community roles', 'Rules and responsibilities']],
    ['Our World', ['Continents and oceans', 'Maps and directions']],
  ],
  'Computer Science': [
    ['Computers Around Us', ['Parts of a computer', 'Staying safe online']],
    ['Thinking Like a Programmer', ['Sequences and steps', 'Simple algorithms']],
  ],
  Technology: [
    ['Design and Make', ['The design process', 'Materials and their uses']],
    ['Simple Machines', ['Levers and wheels', 'Everyday engineering']],
  ],
  'General Knowledge': [
    ['Our Amazing World', ['Wonders of nature', 'Countries and flags']],
    ['Everyday Discovery', ['How things work', 'Famous landmarks']],
  ],
  'Creative Learning': [
    ['Colour and Shape', ['Mixing colours', 'Shapes in art']],
    ['Story and Song', ['Telling a story', 'Rhythm and rhyme']],
  ],
  'Islamic Studies': [
    ['Belief and Worship', ['The Five Pillars of Islam', 'The Six Articles of Faith']],
    ['Manners and Character', ['Good manners with family', 'Honesty and trust']],
  ],
  'Quran Studies': [
    ['Reading the Quran', ['Arabic letters and sounds', 'Reading with tajweed basics']],
    ['Understanding the Quran', ['Meaning of short surahs', 'Living the Quran daily']],
  ],
};

const DUAS = [
  {
    title: 'Before eating',
    arabic: 'بِسْمِ اللَّهِ',
    transliteration: 'Bismillah',
    translation: 'In the name of Allah.',
    reference: 'Sahih al-Bukhari 5376, Sahih Muslim 2022',
    category: 'Daily',
  },
  {
    title: 'After eating',
    arabic: 'الْحَمْدُ لِلَّهِ الَّذِي أَطْعَمَنَا وَسَقَانَا وَجَعَلَنَا مُسْلِمِينَ',
    transliteration: 'Alhamdulillahil-ladhi at‘amana wa saqana wa ja‘alana muslimin',
    translation: 'All praise is for Allah who fed us, gave us drink and made us Muslims.',
    reference: 'Sunan Abi Dawud 3850, Sunan at-Tirmidhi 3457 (hasan)',
    category: 'Daily',
  },
  {
    title: 'Before sleeping',
    arabic: 'بِاسْمِكَ اللَّهُمَّ أَمُوتُ وَأَحْيَا',
    transliteration: 'Bismika Allahumma amutu wa ahya',
    translation: 'In Your name, O Allah, I die and I live.',
    reference: 'Sahih al-Bukhari 6324',
    category: 'Daily',
  },
  {
    title: 'After waking up',
    arabic: 'الْحَمْدُ لِلَّهِ الَّذِي أَحْيَانَا بَعْدَ مَا أَمَاتَنَا وَإِلَيْهِ النُّشُورُ',
    transliteration: 'Alhamdulillahil-ladhi ahyana ba‘da ma amatana wa ilayhin-nushur',
    translation: 'All praise is for Allah who gave us life after death, and to Him is the return.',
    reference: 'Sahih al-Bukhari 6312',
    category: 'Daily',
  },
  {
    title: 'Entering the toilet',
    arabic: 'اللَّهُمَّ إِنِّي أَعُوذُ بِكَ مِنَ الْخُبُثِ وَالْخَبَائِثِ',
    transliteration: 'Allahumma inni a‘udhu bika minal-khubuthi wal-khaba’ith',
    translation: 'O Allah, I seek Your protection from male and female evil spirits.',
    reference: 'Sahih al-Bukhari 142, Sahih Muslim 375',
    category: 'Daily',
  },
  {
    title: 'For travelling',
    arabic: 'سُبْحَانَ الَّذِي سَخَّرَ لَنَا هَذَا وَمَا كُنَّا لَهُ مُقْرِنِينَ وَإِنَّا إِلَى رَبِّنَا لَمُنْقَلِبُونَ',
    transliteration: 'Subhanal-ladhi sakhkhara lana hadha wa ma kunna lahu muqrinin wa inna ila Rabbina lamunqalibun',
    translation: 'Glory to Him who has subjected this to us, though we could not have done so. And truly to our Lord we will return.',
    reference: 'Sahih Muslim 1342; Quran 43:13-14',
    category: 'Travel',
  },
];

const ISLAMIC_LESSONS = [
  {
    title: 'The Five Pillars of Islam',
    category: 'Belief',
    body: 'Islam is built upon five acts of worship: the testimony of faith (shahadah), the daily prayers (salah), giving charity (zakah), fasting in Ramadan (sawm) and the pilgrimage to Makkah (hajj) for those who are able. Each pillar teaches a Muslim to remember Allah, to be disciplined and to care for other people.',
    reference: 'Sahih al-Bukhari 8, Sahih Muslim 16',
  },
  {
    title: 'The Six Articles of Faith',
    category: 'Belief',
    body: 'A Muslim believes in Allah alone, in His angels, in His revealed books, in His messengers, in the Last Day and in divine decree. These beliefs shape how a Muslim understands the world and how to live honestly and patiently.',
    reference: 'Sahih Muslim 8 (Hadith of Jibril)',
  },
  {
    title: 'How to perform Wudu',
    category: 'Worship',
    body: 'Wudu is the purification before prayer. A simple description: intend purification, wash the hands, rinse the mouth, rinse the nose, wash the face, wash the arms to the elbows, wipe the head, then wash the feet to the ankles. Wudu is broken by using the toilet, passing wind or deep sleep, and it is renewed before prayer.',
    reference: 'Quran 5:6; Sahih al-Bukhari 159',
  },
  {
    title: 'The daily prayers (Salah)',
    category: 'Worship',
    body: 'Muslims pray five times each day: Fajr before sunrise, Dhuhr after midday, Asr in the afternoon, Maghrib just after sunset and Isha at night. Each prayer has a set number of units (rakah) and is performed facing the qiblah in Makkah. Praying regularly helps a person remember Allah throughout the day.',
    reference: 'Quran 17:78; Sahih al-Bukhari 521',
  },
  {
    title: 'Prophets in Islam',
    category: 'Prophets',
    body: 'Allah sent many prophets to guide people, including Adam, Nuh, Ibrahim, Musa, Isa and finally Muhammad (peace be upon them all). Muslims believe all the prophets taught the same essential message: to worship Allah alone. Their stories teach patience, honesty and trust in Allah.',
    reference: 'Quran 2:285; Quran 33:40',
  },
  {
    title: 'Good character and manners',
    category: 'Manners',
    body: 'The Prophet Muhammad (peace be upon him) taught kindness to parents, honesty in speech, keeping promises, respecting neighbours and controlling anger. Good manners are part of worship and are shown in small daily actions: greeting others, sharing, speaking gently and helping at home.',
    reference: 'Sahih al-Bukhari 6011; Sunan at-Tirmidhi 1927',
  },
];

const SURAH_FALLBACK = [
  [1, 'الفاتحة', 'Al-Fatihah', 'The Opening', 7, 'Meccan'],
  [2, 'البقرة', 'Al-Baqarah', 'The Cow', 286, 'Medinan'],
  [18, 'الكهف', 'Al-Kahf', 'The Cave', 110, 'Meccan'],
  [36, 'يس', 'Ya-Sin', 'Ya Sin', 83, 'Meccan'],
  [55, 'الرحمن', 'Ar-Rahman', 'The Most Merciful', 78, 'Medinan'],
  [67, 'الملك', 'Al-Mulk', 'The Sovereignty', 30, 'Meccan'],
  [78, 'النبأ', 'An-Naba', 'The Tidings', 40, 'Meccan'],
  [87, 'الأعلى', 'Al-A\'la', 'The Most High', 19, 'Meccan'],
  [93, 'الضحى', 'Ad-Duhaa', 'The Morning Hours', 11, 'Meccan'],
  [94, 'الشرح', 'Ash-Sharh', 'The Relief', 8, 'Meccan'],
  [97, 'القدر', 'Al-Qadr', 'The Power', 5, 'Meccan'],
  [99, 'الزلزلة', 'Az-Zalzalah', 'The Earthquake', 8, 'Medinan'],
  [103, 'العصر', 'Al-Asr', 'The Declining Day', 3, 'Meccan'],
  [105, 'الفيل', 'Al-Fil', 'The Elephant', 5, 'Meccan'],
  [106, 'قريش', 'Quraysh', 'Quraysh', 4, 'Meccan'],
  [107, 'الماعون', 'Al-Ma\'un', 'Small Kindnesses', 7, 'Meccan'],
  [108, 'الكوثر', 'Al-Kawthar', 'The Abundance', 3, 'Meccan'],
  [109, 'الكافرون', 'Al-Kafirun', 'The Disbelievers', 6, 'Meccan'],
  [110, 'النصر', 'An-Nasr', 'The Divine Support', 3, 'Medinan'],
  [111, 'المسد', 'Al-Masad', 'The Palm Fibre', 5, 'Meccan'],
  [112, 'الإخلاص', 'Al-Ikhlas', 'Sincerity', 4, 'Meccan'],
  [113, 'الفلق', 'Al-Falaq', 'The Daybreak', 5, 'Meccan'],
  [114, 'الناس', 'An-Nas', 'Mankind', 6, 'Meccan'],
];

const BOOKS = [
  { title: 'The Secret Island Adventure', author: 'R. Mwangi', category: 'Fiction', subcategory: 'Adventure', class_level: 4, format: 'pdf', color: '#1e3a8a', description: 'Four friends discover an island that appears on no map and learn that courage grows when you help each other.' },
  { title: 'Mystery at Maple Street', author: 'L. Hartley', category: 'Fiction', subcategory: 'Mystery', class_level: 5, format: 'pdf', color: '#7c2d12', description: 'A missing notebook, a locked shed and a detective club determined to solve the case before the school term ends.' },
  { title: 'The Sky Whale', author: 'P. Osei', category: 'Fiction', subcategory: 'Fantasy', class_level: 3, format: 'epub', color: '#0e7490', description: 'A gentle fantasy about a whale that swims through clouds and the girl who befriends her.' },
  { title: 'Journey to the Red Planet', author: 'S. Nakamura', category: 'Fiction', subcategory: 'Science fiction', class_level: 7, format: 'epub', color: '#b91c1c', description: 'A young engineering crew must repair their spacecraft before the long voyage to Mars.' },
  { title: 'Little Stories for Big Hearts', author: 'A. Farouk', category: 'Fiction', subcategory: 'Short stories', class_level: 2, format: 'pdf', color: '#db2777', description: 'Ten short, kind stories for early readers, each with a gentle lesson about friendship.' },
  { title: 'The Laughing Classroom', author: 'J. Whitmore', category: 'Fiction', subcategory: 'Funny stories', class_level: 3, format: 'pdf', color: '#ea580c', description: 'Silly things keep happening in Class 3B, and the class decides to write it all down.' },
  { title: 'When Cairo Ruled the Skies', author: 'H. Al-Masri', category: 'Fiction', subcategory: 'Historical fiction', class_level: 8, format: 'epub', color: '#78350f', description: 'A historical story set in a busy medieval city of scholars, markets and libraries.' },
  { title: 'How the Human Body Works', author: 'Dr. K. Patel', category: 'Non-fiction', subcategory: 'Science', class_level: 6, format: 'pdf', color: '#0f766e', description: 'A clear tour of the heart, lungs, brain and digestive system with simple diagrams explained in words.' },
  { title: 'Amazing Animals of the World', author: 'N. Bello', category: 'Non-fiction', subcategory: 'Animals', class_level: 2, format: 'pdf', color: '#15803d', description: 'Meet animals with surprising abilities, from elephants that remember to birds that travel across oceans.' },
  { title: 'Our Blue Planet', author: 'E. Sorensen', category: 'Non-fiction', subcategory: 'Nature', class_level: 4, format: 'pdf', color: '#0369a1', description: 'Oceans, forests, deserts and the small choices that help protect them.' },
  { title: 'Stars, Planets and Beyond', author: 'M. Qureshi', category: 'Non-fiction', subcategory: 'Space', class_level: 6, format: 'pdf', color: '#1e1b4b', description: 'The solar system, star life cycles and how astronomers learn about distant worlds.' },
  { title: 'Maps and Continents', author: 'T. Adeyemi', category: 'Non-fiction', subcategory: 'Geography', class_level: 5, format: 'pdf', color: '#b45309', description: 'How to read maps, compare continents and understand landforms and climates.' },
  { title: 'Great Inventors and Their Machines', author: 'R. Ilyas', category: 'Non-fiction', subcategory: 'Inventions', class_level: 7, format: 'pdf', color: '#0f172a', description: 'Stories of problem solvers whose small ideas changed everyday life.' },
  { title: 'Stories of the Prophets: An Introduction', author: 'STUDYFLIX Editorial', category: 'Islamic', subcategory: 'Prophets', class_level: 5, format: 'pdf', color: '#065f46', description: 'An introduction to the prophets mentioned in the Quran and the lessons of their stories. Compiled from Quranic references.' },
  { title: 'Islamic Manners for Young Muslims', author: 'STUDYFLIX Editorial', category: 'Islamic', subcategory: 'Manners', class_level: 2, format: 'pdf', color: '#047857', description: 'Simple everyday manners: greeting, sharing, honesty, kindness to parents and caring for neighbours.' },
  { title: 'My First Word Book', author: 'STUDYFLIX Editorial', category: 'Other', subcategory: 'Vocabulary', class_level: 1, format: 'pdf', color: '#7e22ce', description: 'A picture-free word book with short, simple sentences to build early reading confidence.' },
  { title: 'Poems for Rainy Days', author: 'S. Iqbal', category: 'Other', subcategory: 'Poetry', class_level: 6, format: 'epub', color: '#334155', description: 'A small collection of gentle poems about weather, books and quiet afternoons.' },
  { title: 'The Maths Puzzle Club', author: 'F. Osman', category: 'Educational', subcategory: 'Mathematics', class_level: 5, format: 'pdf', color: '#1d4ed8', description: 'Number puzzles, patterns and logic challenges that make practice feel like play.' },
];

const SAMPLE_CHAPTERS = [
  {
    title: 'Chapter 1 — Getting Started',
    paragraphs: [
      'This Reading Corner edition is prepared so that students always have something meaningful to read, practise and discuss with their teacher.',
      'Read slowly. When you meet a new word, say it aloud, then read the whole sentence again. Understanding grows with patience, and every reader improves by reading a little every day.',
      'After this chapter, write two sentences in your reading notes about what you noticed. Your notes stay private in your account and help you remember what you learned.',
    ],
  },
  {
    title: 'Chapter 2 — A Closer Look',
    paragraphs: [
      'Good readers ask questions while they read. Who is this about? What just happened? What might happen next? Asking questions keeps your attention on the page.',
      'Try explaining this chapter to a friend in one minute. Explaining is one of the strongest ways to remember something, because it makes you organise the ideas in your own words.',
      'If something is unclear, use the STUDYFLIX AI assistant to ask for a simpler explanation, then confirm with your teacher during class.',
    ],
  },
  {
    title: 'Chapter 3 — Practice and Reflection',
    paragraphs: [
      'Practice is not about speed. It is about returning to the same idea from a different direction until it feels familiar.',
      'At the end of this chapter, add a bookmark so you can return, and mark your reading progress so your dashboard shows how far you have travelled.',
      'Well done for reading today. A few pages each day becomes hundreds of pages each year.',
    ],
  },
];

const bookBlocks = (book) => {
  const blocks = [
    { type: 'h1', text: book.title },
    { type: 'small', text: `By ${book.author} · ${book.category}${book.subcategory ? ' / ' + book.subcategory : ''} · Class ${book.class_level}` },
    { type: 'p', text: book.description },
    { type: 'h2', text: 'About this edition' },
    { type: 'p', text: 'STUDYFLIX Reading Corner sample edition, provided for classroom reading practice. Teachers may replace this file with a licensed or public-domain edition at any time from the Reading Corner administration shelf.' },
  ];
  for (const chapter of SAMPLE_CHAPTERS) {
    blocks.push({ type: 'h2', text: chapter.title });
    for (const paragraph of chapter.paragraphs) blocks.push({ type: 'p', text: paragraph });
  }
  return blocks;
};

const docBlocks = (title, docType, subjectName, classLevel) => [
  { type: 'h1', text: title },
  { type: 'small', text: `${subjectName} · ${docType} · Class ${classLevel} · STUDYFLIX academic resource` },
  { type: 'h2', text: 'What this resource covers' },
  { type: 'p', text: `This ${docType.toLowerCase()} supports the ${subjectName} curriculum for Class ${classLevel}. Work through the sections in order, and use the practice questions at the end to check your understanding.` },
  { type: 'h2', text: 'Key ideas' },
  { type: 'p', text: '1. Read the learning objective before you begin so you know what to look for.' },
  { type: 'p', text: '2. Write short notes in your own words. Notes you write yourself are easier to revise than notes you copy.' },
  { type: 'p', text: '3. Practise a little every day rather than everything at once.' },
  { type: 'h2', text: 'Practice questions' },
  { type: 'p', text: '1. Explain the main idea of this resource in two sentences.' },
  { type: 'p', text: '2. Give one example from your own experience that connects to this topic.' },
  { type: 'p', text: '3. Write one question you still want to ask your teacher.' },
  { type: 'h2', text: 'Teacher notes' },
  { type: 'p', text: 'Use this document as a starting point for class discussion. Students can submit written answers through the Assignment Centre.' },
];

function writeFile(name, buffer) {
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer);
  return name;
}

export function seedIfEmpty() {
  if (isSeeded()) return false;
  if (get('SELECT COUNT(*) AS c FROM users').c > 0) {
    markSeeded();
    return false;
  }

  for (const [level, name, band] of CLASSES) {
    run('INSERT OR REPLACE INTO classes (level, name, band) VALUES (?, ?, ?)', [level, name, band]);
  }

  const subjectIds = {};
  for (const [name, icon, color, description, classes] of SUBJECTS) {
    const { lastId } = run(
      'INSERT INTO subjects (name, icon, color, description, status) VALUES (?, ?, ?, ?, ?)',
      [name, icon, color, description, 'published'],
    );
    subjectIds[name] = lastId;
    for (const level of classes) {
      run('INSERT OR IGNORE INTO subject_classes (subject_id, class_level) VALUES (?, ?)', [lastId, level]);
    }
    const chapters = CURRICULUM[name] || [];
    chapters.forEach(([chapterTitle, lessons], chapterIndex) => {
      for (const level of classes) {
        const chapter = run(
          'INSERT INTO chapters (subject_id, class_level, title, description, position, status) VALUES (?, ?, ?, ?, ?, ?)',
          [lastId, level, chapterTitle, `${chapterTitle} for Class ${level}.`, chapterIndex + 1, 'published'],
        );
        lessons.forEach((lessonTitle, lessonIndex) => {
          run(
            'INSERT INTO lessons (chapter_id, title, kind, content, duration_minutes, position, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
              chapter.lastId,
              lessonTitle,
              lessonIndex === 0 ? 'reading' : 'activity',
              `Class ${level} · ${name} · ${chapterTitle}. ${lessonTitle}: read the key ideas, then complete the short practice task and add a note to your notebook.`,
              8 + lessonIndex * 4,
              lessonIndex + 1,
              'published',
            ],
          );
        });
      }
    });
  }

  const adminId = run(
    'INSERT INTO users (username, password_hash, role, full_name, display_name, student_id, avatar, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ['admin', hashPassword('Studyflix@2025'), 'super_admin', 'Amina Yusuf', 'Principal Amina', 'ADM-001', '🛡️', 'active'],
  ).lastId;

  const teacherSeed = [
    ['teacher.rahman', 'Rahman Aliyu', 'Mr. Rahman', 'TCH-001', '👨‍🏫'],
    ['teacher.sara', 'Sara Idris', 'Ms. Sara', 'TCH-002', '👩‍🏫'],
    ['teacher.ibrahim', 'Ibrahim Sule', 'Mr. Ibrahim', 'TCH-003', '🧑‍🏫'],
  ];
  const teacherIds = teacherSeed.map(([username, fullName, displayName, staffId, avatar]) =>
    run(
      'INSERT INTO users (username, password_hash, role, full_name, display_name, student_id, avatar, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [username, hashPassword('Teach@2025'), 'teacher', fullName, displayName, staffId, avatar, 'active'],
    ).lastId,
  );

  const teacherAssignments = [
    [teacherIds[0], 'Mathematics', [6, 7, 8]],
    [teacherIds[0], 'Science', [6, 7]],
    [teacherIds[1], 'English', [3, 4, 5]],
    [teacherIds[1], 'Creative Learning', [1, 2, 3]],
    [teacherIds[2], 'Islamic Studies', [1, 2, 3, 4, 5, 6, 7, 8]],
    [teacherIds[2], 'Quran Studies', [1, 2, 3, 4, 5, 6, 7, 8]],
  ];
  for (const [teacherId, subjectName, levels] of teacherAssignments) {
    for (const level of levels) {
      run('INSERT OR IGNORE INTO teacher_assignments (teacher_id, subject_id, class_level) VALUES (?, ?, ?)', [
        teacherId,
        subjectIds[subjectName],
        level,
      ]);
    }
  }

  const studentSeed = [
    ['student1', 'Yusuf Adeyemi', 'Yusuf', 'STD-0061', 6, '🧑‍🎓'],
    ['student2', 'Maryam Bello', 'Maryam', 'STD-0024', 2, '👧'],
    ['student3', 'Zainab Khan', 'Zainab', 'STD-0043', 4, '👩‍🎓'],
    ['student4', 'Ibrahim Musa', 'Ibrahim', 'STD-0078', 7, '🧑‍🎓'],
    ['student5', 'Aisha Suleiman', 'Aisha', 'STD-0015', 1, '👧'],
    ['student6', 'Daniel Okoro', 'Daniel', 'STD-0052', 5, '🧒'],
    ['student7', 'Hafsa Nur', 'Hafsa', 'STD-0081', 8, '👩‍🎓'],
    ['student8', 'Bilal Ahmed', 'Bilal', 'STD-0033', 3, '🧒'],
    ['student9', 'Fatima Zahra', 'Fatima', 'STD-0066', 6, '👩‍🎓'],
    ['student10', 'Omar Diallo', 'Omar', 'STD-0047', 4, '🧑‍🎓'],
    ['student11', 'Khadija Ali', 'Khadija', 'STD-0072', 7, '👧'],
    ['student12', 'Sami Tesfaye', 'Sami', 'STD-0009', 1, '🧒'],
  ];
  const studentIds = studentSeed.map(([username, fullName, displayName, studentId, level, avatar]) =>
    run(
      'INSERT INTO users (username, password_hash, role, full_name, display_name, student_id, class_level, avatar, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [username, hashPassword('Learn@2025'), 'student', fullName, displayName, studentId, level, avatar, 'active'],
    ).lastId,
  );

  const docs = [
    ['Class 6 Mathematics — Chapter Notes', 'notes', 'Mathematics', 6],
    ['Fractions Practice Worksheet', 'worksheet', 'Mathematics', 5],
    ['Science Revision Guide — Living Things', 'revision', 'Science', 4],
    ['English Grammar Workbook', 'workbook', 'English', 6],
    ['Islamic Studies — Five Pillars Notes', 'notes', 'Islamic Studies', 3],
    ['Quran Studies — Tajweed Basics', 'study-guide', 'Quran Studies', 5],
    ['Social Studies Practice Paper', 'practice-paper', 'Social Studies', 7],
    ['Computer Science — Online Safety Guide', 'guide', 'Computer Science', 6],
    ['Class 8 Examination Preparation Pack', 'practice-paper', 'Mathematics', 8],
    ['General Knowledge Quiz Sheets', 'worksheet', 'General Knowledge', 4],
  ];
  const docIds = docs.map(([title, docType, subjectName, level], index) => {
    const file = writeFile(
      `seed-doc-${index + 1}.pdf`,
      buildPdf({ title, blocks: docBlocks(title, docType.replace(/-/g, ' '), subjectName, level) }),
    );
    const size = fs.statSync(path.join(UPLOAD_DIR, file)).size;
    return run(
      'INSERT INTO documents (title, doc_type, subject_id, class_level, file_name, mime, size, pages, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [title, docType, subjectIds[subjectName], level, file, 'application/pdf', size, 2, 'published', adminId],
    ).lastId;
  });

  const bookIds = BOOKS.map((book, index) => {
    const fileName = `seed-book-${index + 1}.${book.format}`;
    const buffer =
      book.format === 'epub'
        ? buildEpub({
            title: book.title,
            author: book.author,
            chapters: SAMPLE_CHAPTERS.map((chapter) => ({
              title: chapter.title,
              body: chapter.paragraphs.map((p) => `<p>${p}</p>`).join('\n'),
            })),
          })
        : buildPdf({ title: book.title, blocks: bookBlocks(book) });
    writeFile(fileName, buffer);
    return run(
      `INSERT INTO books (title, author, description, category, subcategory, class_level, reading_level, language, format, cover_color, file_name, pages, featured, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        book.title,
        book.author,
        book.description,
        book.category,
        book.subcategory,
        book.class_level,
        book.class_level <= 2 ? 'Early' : book.class_level <= 5 ? 'Growing' : 'Fluent',
        'English',
        book.format,
        book.color,
        fileName,
        book.format === 'pdf' ? 5 : 3,
        index < 4 ? 1 : 0,
        'published',
        adminId,
      ],
    ).lastId;
  });

  for (const dua of DUAS) {
    run('INSERT INTO islamic_duas (title, arabic, transliteration, translation, reference, category) VALUES (?, ?, ?, ?, ?, ?)', [
      dua.title,
      dua.arabic,
      dua.transliteration,
      dua.translation,
      dua.reference,
      dua.category,
    ]);
  }
  ISLAMIC_LESSONS.forEach((lesson, index) => {
    run('INSERT INTO islamic_lessons (title, category, body, reference, class_level, position) VALUES (?, ?, ?, ?, ?, ?)', [
      lesson.title,
      lesson.category,
      lesson.body,
      lesson.reference,
      null,
      index + 1,
    ]);
  });
  for (const surah of SURAH_FALLBACK) {
    run('INSERT OR IGNORE INTO surahs (id, name_arabic, name_english, meaning, ayahs, revelation) VALUES (?, ?, ?, ?, ?, ?)', surah);
  }

  const quizSeed = [
    {
      title: 'Mathematics — Fractions Check',
      description: 'A short check on equivalent fractions and simple addition.',
      subject: 'Mathematics',
      class_level: 6,
      time_limit: 10,
      questions: [
        ['mcq', 'Which fraction is equivalent to 1/2?', ['2/4', '1/3', '3/5', '2/5'], '2/4', 2],
        ['mcq', 'What is 1/4 + 1/4?', ['1/2', '1/8', '2/8', '1/4'], '1/2', 2],
        ['truefalse', '3/6 is the same as 1/2.', ['True', 'False'], 'True', 1],
        ['short', 'Write one fraction equivalent to 2/3.', [], '4/6', 2],
        ['mcq', 'Which fraction is the largest?', ['3/4', '2/3', '1/2', '4/9'], '3/4', 2],
      ],
    },
    {
      title: 'Science — Living Things',
      description: 'Recall the needs of living things and the parts of a plant.',
      subject: 'Science',
      class_level: 6,
      time_limit: 10,
      questions: [
        ['mcq', 'Which of these is a need of all living things?', ['Water', 'Television', 'Traffic', 'Homework'], 'Water', 1],
        ['mcq', 'Which part of a plant absorbs water?', ['Roots', 'Flower', 'Leaf', 'Fruit'], 'Roots', 1],
        ['truefalse', 'All living things breathe.', ['True', 'False'], 'True', 1],
        ['short', 'Name one thing plants need to make food.', [], 'Sunlight', 1],
      ],
    },
    {
      title: 'Islamic Studies — Pillars and Faith',
      description: 'A gentle quiz on the five pillars and six articles of faith.',
      subject: 'Islamic Studies',
      class_level: 4,
      time_limit: 8,
      questions: [
        ['mcq', 'How many pillars does Islam have?', ['Five', 'Three', 'Seven', 'Ten'], 'Five', 1],
        ['mcq', 'Which pillar comes after salah?', ['Zakah', 'Hajj', 'Shahadah', 'Sawm'], 'Zakah', 1],
        ['truefalse', 'Fasting in Ramadan is one of the pillars of Islam.', ['True', 'False'], 'True', 1],
        ['short', 'In which month do Muslims fast?', [], 'Ramadan', 1],
      ],
    },
  ];
  for (const quiz of quizSeed) {
    const quizId = run(
      'INSERT INTO quizzes (title, description, subject_id, class_level, time_limit, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [quiz.title, quiz.description, subjectIds[quiz.subject], quiz.class_level, quiz.time_limit, 'published', teacherIds[0]],
    ).lastId;
    quiz.questions.forEach(([type, prompt, options, answer, marks], index) => {
      run(
        'INSERT INTO quiz_questions (quiz_id, type, prompt, options, answer, marks, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [quizId, type, prompt, JSON.stringify(options), answer, marks, index + 1],
      );
    });
  }

  const assignmentSeed = [
    ['Fractions problem set', 'Complete questions 1-10 from the fractions worksheet. Show your working for each answer.', 'Mathematics', 6, 5],
    ['Plant observation journal', 'Observe a plant near your home for three days and write a short journal about what you notice.', 'Science', 6, 7],
    ['My favourite short surah', 'Write the meaning of one short surah you have learned and explain one lesson from it.', 'Quran Studies', 4, 4],
  ];
  for (const [title, description, subjectName, level, days] of assignmentSeed) {
    const due = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    run(
      'INSERT INTO assignments (title, description, subject_id, class_level, due_at, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [title, description, subjectIds[subjectName], level, due, 'published', teacherIds[0]],
    );
  }

  run(
    'INSERT INTO announcements (title, body, audience, status, created_by) VALUES (?, ?, ?, ?, ?)',
    [
      'Welcome to the new school term',
      'All classes begin on Monday. Check your dashboard for your weekly plan, and remember to bring your reading book every day.',
      'all',
      'published',
      adminId,
    ],
  );
  run(
    'INSERT INTO announcements (title, body, audience, class_level, status, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [
      'Class 6 mathematics clinic',
      'Mr. Rahman will run a mathematics clinic on Thursday after school for anyone who wants extra help with fractions.',
      'class',
      6,
      'published',
      teacherIds[0],
    ],
  );

  const demoStudent = studentIds[0];
  const demoClass = 6;

  run('INSERT INTO bookshelf (user_id, book_id, shelf, progress, last_location, last_page, reading_seconds) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    demoStudent,
    bookIds[0],
    'reading',
    62,
    '3',
    3,
    3200,
  ]);
  run('INSERT INTO bookshelf (user_id, book_id, shelf, progress, last_location, last_page, reading_seconds) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    demoStudent,
    bookIds[7],
    'reading',
    25,
    '2',
    2,
    1200,
  ]);
  run('INSERT INTO bookshelf (user_id, book_id, shelf, progress) VALUES (?, ?, ?)', [demoStudent, bookIds[13], 'want']);
  run('INSERT INTO bookshelf (user_id, book_id, shelf, progress) VALUES (?, ?, ?)', [demoStudent, bookIds[2], 'later']);
  run('INSERT INTO bookshelf (user_id, book_id, shelf, progress) VALUES (?, ?, ?)', [demoStudent, bookIds[4], 'completed', 100]);
  run('INSERT INTO bookmarks (user_id, book_id, location, page, label) VALUES (?, ?, ?, ?, ?)', [
    demoStudent,
    bookIds[0],
    '3',
    3,
    'The map room',
  ]);
  run('INSERT INTO reading_notes (user_id, book_id, page, body) VALUES (?, ?, ?, ?)', [
    demoStudent,
    bookIds[0],
    2,
    'I liked how the friends shared the work. My question: why did the island not appear on the map?',
  ]);
  run('INSERT INTO notes (user_id, title, body, subject) VALUES (?, ?, ?, ?)', [
    demoStudent,
    'Fractions revision',
    'Equivalent fractions: multiply or divide the top and bottom by the same number. 1/2 = 2/4 = 3/6.',
    'Mathematics',
  ]);
  run('INSERT INTO notes (user_id, title, body, subject) VALUES (?, ?, ?, ?)', [
    demoStudent,
    'Science keywords',
    'Photosynthesis, chlorophyll, root, stem, leaf, gas exchange.',
    'Science',
  ]);
  run('INSERT INTO learning_goals (user_id, title, period, target, progress, done) VALUES (?, ?, ?, ?, ?, ?)', [
    demoStudent,
    'Read 20 pages this week',
    'week',
    20,
    13,
    0,
  ]);
  run('INSERT INTO learning_goals (user_id, title, period, target, progress, done) VALUES (?, ?, ?, ?, ?, ?)', [
    demoStudent,
    'Complete the fractions quiz',
    'day',
    1,
    0,
    0,
  ]);
  run('INSERT INTO learning_goals (user_id, title, period, target, progress, done) VALUES (?, ?, ?, ?, ?, ?)', [
    demoStudent,
    'Revise Surah Al-Fatihah',
    'week',
    7,
    4,
    0,
  ]);

  for (const [code, title, description] of [
    ['first_lesson', 'First Lesson Completed', 'You completed your first lesson on STUDYFLIX.'],
    ['first_book', 'First Book Read', 'You marked your first book as completed.'],
    ['maths_explorer', 'Maths Explorer', 'You finished a mathematics quiz.'],
  ]) {
    run('INSERT OR IGNORE INTO achievements (user_id, code, title, description) VALUES (?, ?, ?, ?)', [
      demoStudent,
      code,
      title,
      description,
    ]);
  }

  const quizRow = get('SELECT id FROM quizzes WHERE class_level = 6 ORDER BY id LIMIT 1');
  if (quizRow) {
    run('INSERT INTO quiz_attempts (quiz_id, user_id, score, max_score, answers, status) VALUES (?, ?, ?, ?, ?, ?)', [
      quizRow.id,
      demoStudent,
      7,
      9,
      JSON.stringify([{ prompt: 'Which fraction is equivalent to 1/2?', answer: '2/4', correct: true }]),
      'submitted',
    ]);
  }
  const assignmentRow = get('SELECT id FROM assignments WHERE class_level = 6 ORDER BY id LIMIT 1');
  if (assignmentRow) {
    run('INSERT INTO submissions (assignment_id, user_id, body, status, grade, feedback) VALUES (?, ?, ?, ?, ?, ?)', [
      assignmentRow.id,
      demoStudent,
      'I completed questions 1-10 and checked my answers with the answer sheet.',
      'graded',
      8,
      'Neat working. Revise question 7 before the next quiz.',
    ]);
  }

  const attendanceStatuses = ['present', 'present', 'present', 'present', 'excused', 'present', 'present', 'absent', 'present', 'present'];
  attendanceStatuses.forEach((status, index) => {
    const date = new Date(Date.now() - (index + 1) * 86400000);
    if (date.getDay() === 0 || date.getDay() === 6) return;
    run('INSERT OR IGNORE INTO attendance (student_id, class_level, date, status, marked_by) VALUES (?, ?, ?, ?, ?)', [
      demoStudent,
      demoClass,
      date.toISOString().slice(0, 10),
      status,
      teacherIds[0],
    ]);
  });

  run('INSERT INTO notifications (user_id, title, body, kind, link) VALUES (?, ?, ?, ?, ?)', [
    demoStudent,
    'New book added to the Reading Corner',
    'The Secret Island Adventure is now available for Class 6.',
    'book',
    '/reading',
  ]);
  run('INSERT INTO notifications (user_id, title, body, kind, link) VALUES (?, ?, ?, ?, ?)', [
    demoStudent,
    'Assignment due soon',
    'Fractions problem set is due in 5 days.',
    'assignment',
    '/assignments',
  ]);
  run('INSERT INTO notifications (class_level, title, body, kind, link) VALUES (?, ?, ?, ?, ?)', [
    6,
    'Mathematics clinic on Thursday',
    'Mr. Rahman will run an extra mathematics clinic after school.',
    'announcement',
    '/notifications',
  ]);

  run('INSERT INTO audit_logs (actor_id, actor_role, action, target, meta) VALUES (?, ?, ?, ?, ?)', [
    adminId,
    'super_admin',
    'platform.seeded',
    'studyflix',
    'Initial curriculum, library and accounts created.',
  ]);
  run('INSERT INTO audit_logs (actor_id, actor_role, action, target, meta) VALUES (?, ?, ?, ?, ?)', [
    teacherIds[0],
    'teacher',
    'quiz.published',
    'Mathematics — Fractions Check',
    'Published to Class 6.',
  ]);

  markSeeded();
  saveNow();
  return true;
}
