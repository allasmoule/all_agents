export interface Comment {
  author: string;
  text: string;
  url: string;
}

export interface Post {
  id: string;
  platform: string;
  source: string;
  caption: string;
  url: string;
  postDate: string;
  createdTime: string;
  imageUrl?: string;
  comments?: Comment[];
}
