/**
 * Her story (08-copy-ar §1.2) — the ONLY first-person («أنا») text on the
 * site (§0.1). Built on verified facts only: Madinah, licensed by the Ministry
 * of Labour, consent before publishing. The optional personal sentence the
 * copy deck reserves for the owner is left out until she supplies it.
 */
export default function StorySection() {
  return (
    <section className="home-story section" aria-labelledby="home-story-title">
      <div className="home-story__layout container">
        <p className="eyebrow home-story__label reveal">سندس يار</p>

        <div className="home-story__content reveal">
          <h2 id="home-story-title" className="home-story__title">
            أنا سندس
          </h2>
          <p>
            أوثّق يوم العروس بعين هادئة تهتم بالتفاصيل الصغيرة كما تهتم
            باللحظات الكبيرة — يد الحناء، والنظرة الأخيرة في المرآة، ولحظة
            تبادل الخواتم. أعمل في المدينة المنورة، وأنا مصورة مصرّحة من وزارة
            العمل.
          </p>
          <p>
            أهتم بخصوصية كل عروس بقدر اهتمامي بجودة كل صورة: صوركِ ملككِ
            أولًا، ولا تُنشر في أي مكان إلا بإذنكِ الصريح.
          </p>
        </div>
      </div>
    </section>
  )
}
