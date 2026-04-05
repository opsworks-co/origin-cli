import React from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router-dom';
import { blogPosts } from '../data/blogPosts';
import { FadeIn, StaggerContainer } from '../components/FadeIn';

export default function Blog() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <Helmet>
        <title>Blog — Origin | AI Code Governance Insights</title>
        <meta name="description" content="Engineering insights, product updates, and best practices for governing AI-generated code. Learn about AI code attribution, policy enforcement, and compliance." />
        <link rel="canonical" href="https://getorigin.io/blog" />
      </Helmet>
      <div className="max-w-5xl mx-auto px-6 py-16">
        <FadeIn>
          <h1 className="text-4xl font-bold mb-2">Blog</h1>
          <p className="text-gray-400 mb-12">Engineering insights, product updates, and thoughts on AI-assisted development.</p>
        </FadeIn>

        <StaggerContainer className="grid gap-8 sm:grid-cols-2 lg:grid-cols-2" staggerMs={120}>
          {blogPosts.map((post) => (
            <Link
              key={post.slug}
              to={`/blog/${post.slug}`}
              className="group block bg-gray-900 border border-gray-800 rounded-xl p-6 hover:border-indigo-500/50 hover:shadow-lg hover:shadow-indigo-500/5 hover:-translate-y-0.5 transition-all duration-300"
            >
              <div className="flex flex-wrap gap-2 mb-3">
                {post.tags.map((tag) => (
                  <span
                    key={tag}
                    className="text-xs px-2 py-0.5 rounded-full bg-indigo-600/20 text-indigo-400 border border-indigo-500/30"
                  >
                    {tag}
                  </span>
                ))}
              </div>
              <h2 className="text-xl font-semibold mb-2 group-hover:text-indigo-400 transition-colors">
                {post.title}
              </h2>
              <p className="text-sm text-gray-400 mb-4 line-clamp-3">{post.excerpt}</p>
              <div className="flex items-center gap-3 text-xs text-gray-500">
                <span>{post.author}</span>
                <span>&middot;</span>
                <span>{new Date(post.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
              </div>
            </Link>
          ))}
        </StaggerContainer>
      </div>
    </div>
  );
}
